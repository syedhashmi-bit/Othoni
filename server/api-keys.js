'use strict';

// API key management. Keys are 32 hex chars prefixed `othoni_` so they're
// recognizable in logs / leaked secrets scanners. Stored hashed (SHA-256)
// at data/api-keys.json with 0600 perms; the plaintext key is shown to the
// admin exactly once at generation time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'api-keys.json');
const KEY_PREFIX = 'othoni_';
const KEY_BYTES = 16; // → 32 hex chars after the prefix
const LAST_USED_FLUSH_MS = 60_000; // debounce — only persist lastUsedAt once / min

let storePath = process.env.OTHONI_API_KEYS_PATH || DEFAULT_PATH;
let cache = null;            // { keys: [{id, label, hash, createdAt, lastUsedAt}] }
let lastUsedDirty = false;
let flushTimer = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFromDisk() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && Array.isArray(parsed.keys) ? parsed : { keys: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`api-keys: read failed (${e.message}); starting fresh`);
    cache = { keys: [] };
  }
  return cache;
}

function persist() {
  ensureDir(storePath);
  // Write atomically (write to .tmp, rename) so a crash mid-write can't
  // leave half a JSON file behind.
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  // Re-apply mode in case the rename target existed with looser perms.
  try { fs.chmodSync(storePath, 0o600); } catch { /* ignore */ }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (lastUsedDirty) {
      lastUsedDirty = false;
      try { persist(); } catch (e) { logger.warn(`api-keys: lastUsed flush failed: ${e.message}`); }
    }
  }, LAST_USED_FLUSH_MS);
  flushTimer.unref?.();
}

function hashKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function newId() {
  return crypto.randomBytes(6).toString('hex'); // short, opaque, unique enough
}

function isValidLabel(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 80;
}

function listKeys() {
  loadFromDisk();
  // Never return hashes — only the metadata the UI / admin needs.
  return cache.keys.map((k) => ({
    id: k.id,
    label: k.label,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || null,
    fingerprint: k.hash.slice(0, 8), // for visual recognition
  }));
}

function generateKey(label) {
  if (!isValidLabel(label)) {
    const e = new Error('label must be a string of 1–80 chars');
    e.code = 'invalid_label';
    throw e;
  }
  loadFromDisk();
  const plaintext = KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('hex');
  const entry = {
    id: newId(),
    label,
    hash: hashKey(plaintext),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  cache.keys.push(entry);
  persist();
  // Plaintext is returned ONCE here and never persisted.
  return {
    id: entry.id,
    label: entry.label,
    createdAt: entry.createdAt,
    fingerprint: entry.hash.slice(0, 8),
    plaintext,
  };
}

function revokeKey(id) {
  loadFromDisk();
  const before = cache.keys.length;
  cache.keys = cache.keys.filter((k) => k.id !== id);
  if (cache.keys.length === before) return false;
  persist();
  return true;
}

// Lookup the key entry whose hash matches `plaintext`. Constant-time across
// all stored keys so a length comparison can't shortcut the loop.
function lookup(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.startsWith(KEY_PREFIX)) return null;
  loadFromDisk();
  if (cache.keys.length === 0) return null;
  const candidateHash = Buffer.from(hashKey(plaintext), 'hex');
  let match = null;
  for (const k of cache.keys) {
    const stored = Buffer.from(k.hash, 'hex');
    if (stored.length === candidateHash.length
        && crypto.timingSafeEqual(stored, candidateHash)) {
      match = k;
      // intentionally don't `break` to keep the timing flat
    }
  }
  return match;
}

// Mark a key as just-used. Updates the in-memory entry immediately and
// schedules an eventually-consistent flush to disk (every 60s at most).
function touch(id) {
  if (!cache) return;
  const entry = cache.keys.find((k) => k.id === id);
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  lastUsedDirty = true;
  scheduleFlush();
}

function reset() {
  cache = null;
  lastUsedDirty = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

function setStorePath(p) {
  storePath = p;
  reset();
}

module.exports = {
  listKeys,
  generateKey,
  revokeKey,
  lookup,
  touch,
  reset,
  setStorePath,
  KEY_PREFIX,
};
