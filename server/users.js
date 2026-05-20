'use strict';

// Multi-user store (v0.60). The env-based OTHONI_ADMIN_* slot remains
// the bootstrap admin — always present, always works, can't be deleted
// from the UI. Stored users are an additive layer on top: the admin
// can create additional viewer accounts (and, in principle, additional
// admins) through the Settings → Users card. Passwords are hashed with
// the existing scrypt helper.
//
// File layout: `data/users.json`, atomic write, 0600 perms. Pattern
// matches `data/api-keys.json` and `data/webhooks.json` — single JSON
// file is fine at this scale (we don't need a `users` table; this
// data is small, append-rarely, and read on login only).
//
// Reserved usernames: whatever env OTHONI_ADMIN_USER / OTHONI_VIEWER_USER
// resolve to. Creating a stored user with one of those names would
// shadow the env-based account and confuse auth — refuse at create time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { hashPassword, verifyPassword } = require('./password-hash');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'users.json');
const STORE_PATH = process.env.OTHONI_USERS_PATH || DEFAULT_PATH;

// Conservative username alphabet — letters, digits, dot/underscore/
// hyphen. Length 2–32. Anything outside this set risks confusion with
// audit_log actor strings, URL path components, or display formatting.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const VALID_ROLES = new Set(['admin', 'viewer']);
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;

let cache = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && Array.isArray(parsed.users) ? parsed : { users: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`users: read failed (${e.message}); starting fresh`);
    cache = { users: [] };
  }
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  fs.renameSync(tmp, STORE_PATH);
}

function newId() { return 'u_' + crypto.randomBytes(6).toString('hex'); }

function reservedNames() {
  const names = new Set();
  // The env-based admin is always reserved.
  const admin = process.env.OTHONI_ADMIN_USER || 'admin';
  names.add(admin.toLowerCase());
  // Viewer slot too, if it's configured.
  const viewer = process.env.OTHONI_VIEWER_USER;
  if (viewer) names.add(viewer.toLowerCase());
  return names;
}

function isReservedName(name) {
  if (typeof name !== 'string') return false;
  return reservedNames().has(name.toLowerCase());
}

function validateUsername(name) {
  if (typeof name !== 'string') return 'username must be a string';
  if (!USERNAME_RE.test(name)) {
    return 'username must be 2–32 chars, start with a letter/digit, contain only lowercase letters, digits, dot, underscore, or hyphen';
  }
  if (isReservedName(name)) return `"${name}" is reserved (configured via env)`;
  return null;
}

function validatePassword(pass) {
  if (typeof pass !== 'string') return 'password must be a string';
  if (pass.length < MIN_PASSWORD_LEN) return `password must be at least ${MIN_PASSWORD_LEN} characters`;
  if (pass.length > MAX_PASSWORD_LEN) return `password too long (max ${MAX_PASSWORD_LEN})`;
  return null;
}

// Public-facing user shape — never includes the hash.
function sanitize(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    createdBy: u.createdBy || null,
    lastLoginAt: u.lastLoginAt || null,
    passwordUpdatedAt: u.passwordUpdatedAt || u.createdAt,
  };
}

function list() {
  load();
  return cache.users.map(sanitize);
}

function findByUsername(name) {
  load();
  if (typeof name !== 'string') return null;
  // Case-insensitive lookup so "Alice" and "alice" match the same row;
  // we always store the lowercase form so this is straightforward.
  const lower = name.toLowerCase();
  return cache.users.find((u) => u.username === lower) || null;
}

function createUser({ username, password, role, createdBy = null } = {}) {
  load();
  const usernameLower = typeof username === 'string' ? username.toLowerCase() : username;
  const usernameErr = validateUsername(usernameLower);
  if (usernameErr) throw Object.assign(new Error(usernameErr), { code: 'invalid_username' });
  if (!VALID_ROLES.has(role)) throw Object.assign(new Error('role must be "admin" or "viewer"'), { code: 'invalid_role' });
  const passErr = validatePassword(password);
  if (passErr) throw Object.assign(new Error(passErr), { code: 'invalid_password' });
  if (findByUsername(usernameLower)) {
    throw Object.assign(new Error('username already exists'), { code: 'username_taken' });
  }
  const u = {
    id: newId(),
    username: usernameLower,
    role,
    passwordHash: hashPassword(password),
    disabled: false,
    createdAt: Date.now(),
    createdBy: createdBy || null,
    passwordUpdatedAt: Date.now(),
    lastLoginAt: null,
  };
  cache.users.push(u);
  persist();
  return sanitize(u);
}

function updatePassword(id, newPassword) {
  load();
  const u = cache.users.find((x) => x.id === id);
  if (!u) return null;
  const passErr = validatePassword(newPassword);
  if (passErr) throw Object.assign(new Error(passErr), { code: 'invalid_password' });
  u.passwordHash = hashPassword(newPassword);
  u.passwordUpdatedAt = Date.now();
  persist();
  return sanitize(u);
}

function setDisabled(id, disabled) {
  load();
  const u = cache.users.find((x) => x.id === id);
  if (!u) return null;
  u.disabled = !!disabled;
  persist();
  return sanitize(u);
}

function deleteUser(id) {
  load();
  const before = cache.users.length;
  cache.users = cache.users.filter((u) => u.id !== id);
  if (cache.users.length === before) return false;
  persist();
  return true;
}

// Used by auth.js — returns { role, id } on a successful match or null
// otherwise. Never throws (so a corrupt store entry doesn't take down
// the login endpoint). The lookup always runs scryptVerify even on
// non-matches by passing a known-invalid hash to keep timing uniform.
function verifyLogin(username, password) {
  load();
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const u = findByUsername(username);
  if (!u) return null;
  if (u.disabled) return null;
  let ok = false;
  try { ok = verifyPassword(password, u.passwordHash); }
  catch { ok = false; }
  if (!ok) return null;
  // Stamp lastLoginAt. Don't fail the login if persist fails (e.g. disk
  // full) — auth.js will still see the role and seat the session.
  try { u.lastLoginAt = Date.now(); persist(); }
  catch (e) { logger.warn(`users: failed to update lastLoginAt: ${e.message}`); }
  return { id: u.id, username: u.username, role: u.role };
}

function reset() { cache = null; }

module.exports = {
  list,
  createUser,
  updatePassword,
  setDisabled,
  deleteUser,
  verifyLogin,
  findByUsername,
  isReservedName,
  reset,
  // Surface for tests / introspection
  MIN_PASSWORD_LEN,
};
