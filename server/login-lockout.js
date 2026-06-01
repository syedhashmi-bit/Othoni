'use strict';

// In-memory login lockout, keyed on BOTH source IP and target username.
// Express-rate-limit already caps the raw request rate from a single IP,
// but it doesn't *lock* — after the window expires the attacker can
// resume. This module is the lockout half.
//
// Two independent trackers:
//   - per-IP (MAX_FAILS, default 5): stops one host hammering logins.
//   - per-username (USER_MAX_FAILS, default 20): stops a DISTRIBUTED
//     guessing attack that rotates source IPs against one account — the
//     per-IP tracker alone never trips in that case. The username
//     threshold is deliberately higher so a legitimate user fat-fingering
//     their password from one host trips the per-IP lock first (and a
//     later success clears both counters), while a botnet spread across
//     many IPs still gets stopped at 20 total failures for the account.
//     Tradeoff: an attacker can force a 15-min lock on a known username
//     from any IP — accepted as strictly better than unbounded
//     distributed brute force against a root-powered admin login. Tune or
//     disable via OTHONI_LOGIN_LOCKOUT_USER_FAILS.
//
// In-memory by design (per the roadmap): a process restart wipes the
// state, which is fine — the IPs are still rate-limited by express-rate-
// limit at that point.
//
// Memory bounded by:
//   - cleanup-on-touch (expired entries dropped during reads / writes)
//   - hard cap of CAP_ENTRIES per tracker with LRU-ish eviction.

const logger = require('./logger');
const audit = require('./audit');

const MAX_FAILS = parseInt(process.env.OTHONI_LOGIN_LOCKOUT_FAILS || '5', 10);
const USER_MAX_FAILS = parseInt(
  process.env.OTHONI_LOGIN_LOCKOUT_USER_FAILS || String(MAX_FAILS * 4),
  10
);
const LOCK_MS = parseInt(
  process.env.OTHONI_LOGIN_LOCKOUT_MS || String(15 * 60 * 1000),
  10
);
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // forget entries after 24h of inactivity
const CAP_ENTRIES = 1024;

// key -> { fails, firstFailAt, lastFailAt, lockedUntil }
const ipState = new Map();
const userState = new Map();

// Normalize a username into a stable lockout key. Case-folded + trimmed so
// "Admin" and "admin " can't be used to spread guesses across distinct
// buckets; length-capped so a junk-username flood can't bloat one entry.
function userKey(username) {
  if (typeof username !== 'string') return null;
  const k = username.trim().toLowerCase();
  if (!k) return null;
  return k.slice(0, 128);
}

function purgeExpired(state, now) {
  if (state.size === 0) return;
  for (const [key, e] of state) {
    if (e.lockedUntil && e.lockedUntil > now) continue;
    if (now - (e.lastFailAt || 0) > ENTRY_TTL_MS) state.delete(key);
  }
}

function evictLruIfFull(state) {
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

// Returns { locked, unlockAt?, retryAfterSec? } for one tracker entry.
function checkOne(state, key, now) {
  if (!key) return { locked: false };
  const e = state.get(key);
  if (!e || !e.lockedUntil) return { locked: false };
  if (e.lockedUntil <= now) {
    state.delete(key);
    return { locked: false };
  }
  return {
    locked: true,
    unlockAt: e.lockedUntil,
    retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000),
  };
}

// Record one failure against one tracker. Returns the entry's post-state
// as { locked, unlockAt?, retryAfterSec?, failsRemaining? }.
function recordFailureOne(state, key, maxFails, now, { actor = null, scope = 'ip' } = {}) {
  if (!key) return { locked: false, failsRemaining: Infinity };
  evictLruIfFull(state);
  let e = state.get(key);
  if (!e) e = { fails: 0, firstFailAt: now, lastFailAt: now, lockedUntil: 0 };
  e.fails += 1;
  e.lastFailAt = now;
  if (maxFails > 0 && e.fails >= maxFails && !e.lockedUntil) {
    e.lockedUntil = now + LOCK_MS;
    logger.warn(
      `login-lockout: locking ${scope}=${key} for ${Math.round(LOCK_MS / 1000)}s after ${e.fails} failures` +
        (actor ? ` (last actor: ${actor})` : '')
    );
    audit.log({
      actor,
      action: 'login.lockout',
      ip: scope === 'ip' ? key : null,
      metadata: { scope, fails: e.fails, lockMs: LOCK_MS, unlockAt: e.lockedUntil },
    });
  }
  state.delete(key); // re-insert to bump LRU position
  state.set(key, e);
  return e.lockedUntil
    ? { locked: true, unlockAt: e.lockedUntil, retryAfterSec: Math.ceil(LOCK_MS / 1000) }
    : { locked: false, failsRemaining: maxFails > 0 ? maxFails - e.fails : Infinity };
}

// Pick whichever of two lock results blocks for longer.
function worseOf(a, b) {
  if (a.locked && b.locked) return (a.unlockAt || 0) >= (b.unlockAt || 0) ? a : b;
  return a.locked ? a : b;
}

// Public: is this (ip, username) pair allowed to attempt a login?
function check(ip, username) {
  const now = Date.now();
  purgeExpired(ipState, now);
  purgeExpired(userState, now);
  const ipRes = checkOne(ipState, ip || null, now);
  const userRes = checkOne(userState, userKey(username), now);
  const worst = worseOf(ipRes, userRes);
  return worst.locked ? worst : { locked: false };
}

// Public: record a failed attempt against both the IP and the username.
function recordFailure(ip, { actor = null, username = null } = {}) {
  const now = Date.now();
  purgeExpired(ipState, now);
  purgeExpired(userState, now);
  const ipRes = ip
    ? recordFailureOne(ipState, ip, MAX_FAILS, now, { actor, scope: 'ip' })
    : { locked: false, failsRemaining: Infinity };
  const uKey = userKey(username);
  const userRes = uKey
    ? recordFailureOne(userState, uKey, USER_MAX_FAILS, now, { actor, scope: 'user' })
    : { locked: false, failsRemaining: Infinity };
  const worst = worseOf(ipRes, userRes);
  if (worst.locked) return worst;
  return {
    locked: false,
    failsRemaining: Math.min(
      ipRes.failsRemaining ?? Infinity,
      userRes.failsRemaining ?? Infinity
    ),
  };
}

// Public: a successful login clears both this IP's and this username's
// counters. Other entries are unaffected.
function recordSuccess(ip, username) {
  if (ip) ipState.delete(ip);
  const uKey = userKey(username);
  if (uKey) userState.delete(uKey);
}

// Snapshot for /api/health and the Settings page. Counts only entries
// currently in the locked state, across both trackers.
function snapshot() {
  const now = Date.now();
  let lockedNow = 0;
  let trackedIps = 0;
  for (const e of ipState.values()) {
    trackedIps += 1;
    if (e.lockedUntil && e.lockedUntil > now) lockedNow += 1;
  }
  let lockedUsers = 0;
  let trackedUsers = 0;
  for (const e of userState.values()) {
    trackedUsers += 1;
    if (e.lockedUntil && e.lockedUntil > now) lockedUsers += 1;
  }
  return {
    enabled: (MAX_FAILS > 0 || USER_MAX_FAILS > 0) && LOCK_MS > 0,
    maxFails: MAX_FAILS,
    userMaxFails: USER_MAX_FAILS,
    lockMs: LOCK_MS,
    trackedIps,
    trackedUsers,
    lockedUsers,
    // lockedNow stays IP-scoped for backward compatibility with /api/health
    // consumers; lockedUsers is additive.
    lockedNow: lockedNow + lockedUsers,
  };
}

function _resetForTest() {
  ipState.clear();
  userState.clear();
}

module.exports = {
  check,
  recordFailure,
  recordSuccess,
  snapshot,
  _resetForTest,
};
