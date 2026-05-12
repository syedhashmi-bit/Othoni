'use strict';

// In-memory per-IP login lockout. Express-rate-limit already caps the
// raw request rate from a single IP, but it doesn't *lock* — after the
// window expires the attacker can resume. This module is the lockout
// half: after N consecutive failures the IP is rejected for M minutes
// regardless of request rate.
//
// In-memory by design (per the roadmap): a process restart wipes the
// state, which is fine — the IPs are still rate-limited by express-rate-
// limit at that point, and the alternative (persisting to SQLite) is
// more complexity than warranted for a single-process dashboard.
//
// Memory bounded by:
//   - cleanup-on-touch (expired entries dropped during reads / writes)
//   - hard cap of CAP_ENTRIES (1024) with LRU-ish eviction.

const logger = require('./logger');
const audit = require('./audit');

const MAX_FAILS = parseInt(process.env.OTHONI_LOGIN_LOCKOUT_FAILS || '5', 10);
const LOCK_MS = parseInt(
  process.env.OTHONI_LOGIN_LOCKOUT_MS || String(15 * 60 * 1000),
  10
);
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // forget IPs after 24h of inactivity
const CAP_ENTRIES = 1024;

// ip -> { fails, firstFailAt, lastFailAt, lockedUntil }
const state = new Map();

function purgeExpired(now) {
  if (state.size === 0) return;
  for (const [ip, e] of state) {
    if (e.lockedUntil && e.lockedUntil > now) continue;
    if (now - (e.lastFailAt || 0) > ENTRY_TTL_MS) state.delete(ip);
  }
}

function evictLruIfFull() {
  if (state.size < CAP_ENTRIES) return;
  // Map preserves insertion order; oldest key first. Drop ~1% so we
  // don't pay this cost on every call.
  const drop = Math.max(1, Math.floor(CAP_ENTRIES / 100));
  let n = 0;
  for (const k of state.keys()) {
    state.delete(k);
    if (++n >= drop) break;
  }
}

// Returns { locked: bool, unlockAt?: ms, retryAfterSec?: number }.
function check(ip) {
  if (!ip) return { locked: false };
  const now = Date.now();
  purgeExpired(now);
  const e = state.get(ip);
  if (!e || !e.lockedUntil) return { locked: false };
  if (e.lockedUntil <= now) {
    // Lock expired — reset the entry so the IP starts fresh.
    state.delete(ip);
    return { locked: false };
  }
  return {
    locked: true,
    unlockAt: e.lockedUntil,
    retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000),
  };
}

function recordFailure(ip, { actor = null } = {}) {
  if (!ip) return { locked: false };
  const now = Date.now();
  purgeExpired(now);
  evictLruIfFull();
  let e = state.get(ip);
  if (!e) {
    e = { fails: 0, firstFailAt: now, lastFailAt: now, lockedUntil: 0 };
  }
  e.fails += 1;
  e.lastFailAt = now;
  if (e.fails >= MAX_FAILS && !e.lockedUntil) {
    e.lockedUntil = now + LOCK_MS;
    logger.warn(
      `login-lockout: locking ${ip} for ${Math.round(LOCK_MS / 1000)}s after ${e.fails} failures` +
        (actor ? ` (last actor: ${actor})` : '')
    );
    audit.log({
      actor,
      action: 'login.lockout',
      ip,
      metadata: { fails: e.fails, lockMs: LOCK_MS, unlockAt: e.lockedUntil },
    });
  }
  state.delete(ip); // re-insert to bump LRU position
  state.set(ip, e);
  return e.lockedUntil
    ? { locked: true, unlockAt: e.lockedUntil, retryAfterSec: Math.ceil(LOCK_MS / 1000) }
    : { locked: false, failsRemaining: MAX_FAILS - e.fails };
}

function recordSuccess(ip) {
  if (!ip) return;
  // Successful login from this IP clears its lockout state. Other IPs
  // are unaffected.
  state.delete(ip);
}

// Snapshot for /api/health and the Settings page. Counts only entries
// currently in the locked state.
function snapshot() {
  const now = Date.now();
  let lockedNow = 0;
  let trackedIps = 0;
  for (const e of state.values()) {
    trackedIps += 1;
    if (e.lockedUntil && e.lockedUntil > now) lockedNow += 1;
  }
  return {
    enabled: MAX_FAILS > 0 && LOCK_MS > 0,
    maxFails: MAX_FAILS,
    lockMs: LOCK_MS,
    trackedIps,
    lockedNow,
  };
}

function _resetForTest() {
  state.clear();
}

module.exports = {
  check,
  recordFailure,
  recordSuccess,
  snapshot,
  _resetForTest,
};
