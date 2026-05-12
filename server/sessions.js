'use strict';

// Active session tracking + revocation. JWT cookies are stateless by
// themselves — without this module the only way to invalidate a leaked
// session was rotating OTHONI_JWT_SECRET (which logs everyone out).
//
// On login, we generate a random session id, store a row in `sessions`,
// and bake the id into the JWT as `sid`. On every authenticated request,
// `isActive(sid)` is checked against the table (in-memory cache, refreshed
// on writes). Revoking a session sets `revokedAt` — the next request
// carrying that sid is rejected.
//
// `lastSeenAt` is throttled to one write per session per 30 seconds so a
// busy browser doesn't hammer SQLite.

const crypto = require('crypto');
const history = require('./history');
const logger = require('./logger');

const TOUCH_THROTTLE_MS = 30 * 1000;
// Keep sessions around for forensics for 7 days past their expiry — useful
// for the audit-trail story even after the cookie itself is dead.
const FORENSIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  const db = history.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid          TEXT    NOT NULL PRIMARY KEY,
      actor        TEXT    NOT NULL,
      role         TEXT    NOT NULL,
      ip           TEXT,
      ua           TEXT,
      createdAt    INTEGER NOT NULL,
      lastSeenAt   INTEGER NOT NULL,
      expiresAt    INTEGER NOT NULL,
      revokedAt    INTEGER,
      revokedBy    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_actor       ON sessions(actor);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt   ON sessions(expiresAt);
  `);
  schemaReady = true;
}

// In-memory cache of revoked sids. Authoritative state is in SQLite; this
// just lets the auth middleware skip the DB lookup on hot paths.
const revokedCache = new Set();
const lastTouchedAt = new Map(); // sid -> ms

function loadRevokedFromDb() {
  ensureSchema();
  revokedCache.clear();
  const rows = history.getDb()
    .prepare('SELECT sid FROM sessions WHERE revokedAt IS NOT NULL')
    .all();
  for (const r of rows) revokedCache.add(r.sid);
}

function randomSid() {
  // 192 bits, base64url. Unique even with billions of issued sessions.
  return crypto.randomBytes(24).toString('base64url');
}

// Create a new session row. Returns the sid for the JWT payload.
function create({ actor, role, ip, ua, ttlMs }) {
  ensureSchema();
  const sid = randomSid();
  const now = Date.now();
  history.getDb()
    .prepare(
      `INSERT INTO sessions (sid, actor, role, ip, ua, createdAt, lastSeenAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sid, actor, role, ip || null, ua || null, now, now, now + ttlMs);
  return sid;
}

// Authoritative liveness check. Returns the row if the session is active,
// or null otherwise (unknown / revoked / expired).
function getActive(sid) {
  if (!sid || typeof sid !== 'string') return null;
  if (revokedCache.has(sid)) return null;
  ensureSchema();
  const row = history.getDb()
    .prepare(
      `SELECT sid, actor, role, ip, ua, createdAt, lastSeenAt, expiresAt, revokedAt, revokedBy
       FROM sessions WHERE sid = ?`
    )
    .get(sid);
  if (!row) return null;
  if (row.revokedAt) {
    // Cache miss on a revoked row — backfill so the next lookup is hot.
    revokedCache.add(sid);
    return null;
  }
  if (row.expiresAt <= Date.now()) return null;
  return row;
}

// Throttled lastSeenAt write. Safe to call on every request.
function touch(sid) {
  if (!sid) return;
  const now = Date.now();
  const last = lastTouchedAt.get(sid) || 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  lastTouchedAt.set(sid, now);
  try {
    history.getDb()
      .prepare('UPDATE sessions SET lastSeenAt = ? WHERE sid = ? AND revokedAt IS NULL')
      .run(now, sid);
  } catch (e) {
    logger.warn(`sessions: touch failed for ${sid}: ${e.message}`);
  }
}

// Mark a session revoked. Idempotent; returns true if a row transitioned.
function revoke(sid, { revokedBy = null } = {}) {
  if (!sid) return false;
  ensureSchema();
  const info = history.getDb()
    .prepare(
      `UPDATE sessions SET revokedAt = ?, revokedBy = ?
       WHERE sid = ? AND revokedAt IS NULL`
    )
    .run(Date.now(), revokedBy, sid);
  if (info.changes > 0) {
    revokedCache.add(sid);
    return true;
  }
  return false;
}

// All sessions with a row in the table. Caller filters as needed. Returned
// shape is suitable for direct JSON.
function listAll() {
  ensureSchema();
  return history.getDb()
    .prepare(
      `SELECT sid, actor, role, ip, ua, createdAt, lastSeenAt, expiresAt, revokedAt, revokedBy
       FROM sessions
       ORDER BY (revokedAt IS NULL) DESC, lastSeenAt DESC
       LIMIT 200`
    )
    .all();
}

// Hook for the shared retention sweep in history.cleanup().
function prune() {
  ensureSchema();
  const cutoff = Date.now() - FORENSIC_RETENTION_MS;
  const info = history.getDb()
    .prepare('DELETE FROM sessions WHERE (revokedAt IS NOT NULL AND revokedAt < ?) OR expiresAt < ?')
    .run(cutoff, cutoff);
  // Reload the cache so removed sids stop occupying memory.
  if (info.changes > 0) loadRevokedFromDb();
  return info.changes;
}

module.exports = {
  ensureSchema,
  loadRevokedFromDb,
  create,
  getActive,
  touch,
  revoke,
  listAll,
  prune,
};
