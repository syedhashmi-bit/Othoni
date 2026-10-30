'use strict';

// Local accounts (v0.79): email + password, the default way into a fresh
// install. Google sign-in is an optional extra on top; set
// OTHONI_PASSWORD_LOGIN=off to make an instance Google-only again.
//
// File layout: `data/accounts.json`, atomic write, 0600 perms — same
// pattern as `data/api-keys.json` and `data/webhooks.json`. A single JSON
// file is plenty at this scale: a handful of accounts, read on login.
// Passwords are scrypt-hashed (password-hash.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { hashPassword, verifyPassword } = require('./password-hash');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'accounts.json');
const STORE_PATH = process.env.OTHONI_ACCOUNTS_PATH || DEFAULT_PATH;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(['admin', 'viewer']);
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;
// verifyLogin runs scrypt even for unknown emails so response timing doesn't
// reveal which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

let cache = null;
let cacheStamp = null; // which version of the file `cache` was read from

// On/off switch for the whole password path: login, first-run setup, and
// whether existing password sessions stay valid. Default on.
function passwordLoginEnabled() {
  const v = (process.env.OTHONI_PASSWORD_LOGIN || 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(v);
}

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileStamp() {
  try {
    const st = fs.statSync(STORE_PATH);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

// Re-reads the file whenever it changed underneath us —
// scripts/reset-password.js edits it while the server is running, and the
// new password has to work straight away.
function load() {
  const stamp = fileStamp();
  if (cache && stamp === cacheStamp) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    cache = parsed && Array.isArray(parsed.accounts) ? parsed : { accounts: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`accounts: read failed (${e.message}); starting fresh`);
    cache = { accounts: [] };
  }
  cacheStamp = stamp;
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  fs.renameSync(tmp, STORE_PATH);
  cacheStamp = fileStamp();
}

function newId() { return 'a_' + crypto.randomBytes(6).toString('hex'); }

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function validateEmail(email) {
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return 'enter a valid email address';
  return null;
}

function validatePassword(pass) {
  if (typeof pass !== 'string') return 'password must be a string';
  if (pass.length < MIN_PASSWORD_LEN) return `password must be at least ${MIN_PASSWORD_LEN} characters`;
  if (pass.length > MAX_PASSWORD_LEN) return `password too long (max ${MAX_PASSWORD_LEN})`;
  return null;
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// Public-facing shape — never includes the hash.
function sanitize(a) {
  return {
    id: a.id,
    email: a.email,
    role: a.role,
    disabled: !!a.disabled,
    createdAt: a.createdAt,
    createdBy: a.createdBy || null,
    lastLoginAt: a.lastLoginAt || null,
    passwordUpdatedAt: a.passwordUpdatedAt || a.createdAt,
  };
}

function list() {
  return load().accounts.map(sanitize);
}

function count() {
  return load().accounts.length;
}

function findByEmail(email) {
  const e = normalizeEmail(email);
  return load().accounts.find((a) => a.email === e) || null;
}

function findById(id) {
  return load().accounts.find((a) => a.id === id) || null;
}

function create({ email, password, role = 'viewer', createdBy = null }) {
  load();
  const e = normalizeEmail(email);
  const emailErr = validateEmail(e);
  if (emailErr) throw fail('invalid_email', emailErr);
  if (!VALID_ROLES.has(role)) throw fail('invalid_role', 'role must be "admin" or "viewer"');
  const passErr = validatePassword(password);
  if (passErr) throw fail('invalid_password', passErr);
  if (findByEmail(e)) throw fail('email_taken', 'an account with that email already exists');
  const now = Date.now();
  const a = {
    id: newId(),
    email: e,
    role,
    passwordHash: hashPassword(password),
    disabled: false,
    createdAt: now,
    createdBy,
    passwordUpdatedAt: now,
    lastLoginAt: null,
  };
  cache.accounts.push(a);
  persist();
  return sanitize(a);
}

function setPassword(id, password) {
  const a = findById(id);
  if (!a) return null;
  const passErr = validatePassword(password);
  if (passErr) throw fail('invalid_password', passErr);
  a.passwordHash = hashPassword(password);
  a.passwordUpdatedAt = Date.now();
  persist();
  return sanitize(a);
}

// True when taking `id` out of action would leave no enabled admin who can
// still sign in — the instance would be locked. Google admins count when
// Google sign-in is configured.
function wouldStrandAdmins(id, googleHasAdmins) {
  if (googleHasAdmins) return false;
  return !load().accounts.some((a) => a.id !== id && a.role === 'admin' && !a.disabled);
}

function setDisabled(id, disabled) {
  const a = findById(id);
  if (!a) return null;
  a.disabled = !!disabled;
  persist();
  return sanitize(a);
}

function remove(id) {
  load();
  const before = cache.accounts.length;
  cache.accounts = cache.accounts.filter((a) => a.id !== id);
  if (cache.accounts.length === before) return false;
  persist();
  return true;
}

// { id, email, role } on a correct password for an enabled account, else
// null. Never throws, so a corrupt entry can't take down the login endpoint.
// `stamp: false` checks without recording a login (password changes).
function verifyLogin(email, password, { stamp = true } = {}) {
  if (typeof password !== 'string') return null;
  const a = findByEmail(email);
  let ok = false;
  try { ok = verifyPassword(password, a ? a.passwordHash : DUMMY_HASH); } catch { ok = false; }
  if (!ok || !a || a.disabled) return null;
  if (stamp) {
    try { a.lastLoginAt = Date.now(); persist(); }
    catch (e) { logger.warn(`accounts: failed to update lastLoginAt: ${e.message}`); }
  }
  return { id: a.id, email: a.email, role: a.role };
}

// Current role for a password session's email, or null once the account is
// gone or disabled. auth() calls this on every request.
function roleFor(email) {
  const a = findByEmail(email);
  return a && !a.disabled ? a.role : null;
}

function reset() { cache = null; cacheStamp = null; }

module.exports = {
  passwordLoginEnabled,
  list,
  count,
  findByEmail,
  findById,
  create,
  setPassword,
  setDisabled,
  remove,
  wouldStrandAdmins,
  verifyLogin,
  roleFor,
  reset,
  STORE_PATH,
  MIN_PASSWORD_LEN,
};
