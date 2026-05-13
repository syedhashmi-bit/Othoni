'use strict';

// Nightly SQLite VACUUM scheduler (v0.48). The WAL accretes deleted-row
// pages over time; the periodic cleanup pass DELETEs but doesn't
// reclaim space. Without VACUUM the on-disk footprint slowly grows
// even when the row count is bounded by retention.
//
// Configured via `OTHONI_VACUUM_TIME` (HH:MM 24-hour local time, default
// "03:30"). Set to "off" / "false" / empty to disable. Checks the
// current time every 60 seconds and fires when we cross into the
// scheduled minute; a "fired in this minute" flag prevents double
// runs.
//
// Run order:
//   1. wal_checkpoint(TRUNCATE) flushes WAL into the main DB.
//   2. VACUUM defragments + reclaims free pages.
// Both are synchronous (better-sqlite3); the sample timer just waits.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const history = require('./history');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'vacuum-state.json');
const STATE_PATH = process.env.OTHONI_VACUUM_STATE_PATH || DEFAULT_PATH;

const TIME_RE = /^([0-1]?\d|2[0-3]):([0-5]\d)$/;

let timer = null;
let state = null; // { lastRunAt, reclaimedBytes, durationMs, error }
let running = false;

function isEnabled() {
  const raw = (process.env.OTHONI_VACUUM_TIME || '03:30').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'false' || raw === '0') return false;
  return TIME_RE.test(raw);
}

function scheduledHHMM() {
  const raw = (process.env.OTHONI_VACUUM_TIME || '03:30').trim();
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_e) {
    state = { lastRunAt: null, reclaimedBytes: null, durationMs: null, error: null };
  }
  return state;
}

function persistState() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    logger.warn(`vacuum: state persist failed: ${e.message}`);
  }
}

function dbPath() {
  return process.env.OTHONI_DB || path.join(__dirname, '..', 'data', 'othoni.db');
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

// Only measure the main .db file — the WAL fluctuates around it and can
// briefly grow ~as large as the main file after VACUUM (every page got
// rewritten). The user-facing "reclaimed" number should be steady-state
// main-file shrinkage, not in-flight WAL drift.
function dbFootprint() {
  return fileSize(dbPath());
}

// Milliseconds until the next occurrence of the scheduled HH:MM time.
function msUntilNext() {
  const [h, m] = scheduledHHMM().split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// Synchronous (better-sqlite3). Returns the snapshot for callers that
// want it (e.g. the manual-trigger endpoint).
function runNow({ source = 'scheduler' } = {}) {
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;
  const startedAt = Date.now();
  const before = dbFootprint();
  loadState();
  try {
    const db = history.getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    // Fold the post-VACUUM rewrites back from the WAL into the main
    // file so the measured "after" reflects steady-state size rather
    // than the transient WAL bulge.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = dbFootprint();
    const durationMs = Date.now() - startedAt;
    state.lastRunAt = Date.now();
    state.reclaimedBytes = before - after;
    state.durationMs = durationMs;
    state.error = null;
    state.source = source;
    persistState();
    logger.info(
      `vacuum: ok in ${durationMs}ms, reclaimed ${(state.reclaimedBytes / 1024).toFixed(1)} KB (${source})`
    );
    return { ok: true, ...state };
  } catch (e) {
    state.lastRunAt = Date.now();
    state.error = e.message || String(e);
    state.durationMs = Date.now() - startedAt;
    state.reclaimedBytes = null;
    state.source = source;
    persistState();
    logger.warn(`vacuum: failed: ${state.error}`);
    return { ok: false, ...state };
  } finally {
    running = false;
  }
}

function scheduleNext() {
  const delay = msUntilNext();
  timer = setTimeout(() => {
    runNow({ source: 'scheduler' });
    scheduleNext();
  }, delay);
}

function start() {
  loadState();
  if (!isEnabled()) {
    logger.info('vacuum: disabled (set OTHONI_VACUUM_TIME=HH:MM to enable)');
    return;
  }
  const target = scheduledHHMM();
  const delay = msUntilNext();
  const hStr = Math.floor(delay / 3600000);
  const mStr = Math.floor((delay % 3600000) / 60000);
  logger.info(`vacuum: scheduled daily at ${target} local (next run in ${hStr}h ${mStr}m)`);
  scheduleNext();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function snapshot() {
  loadState();
  return {
    enabled: isEnabled(),
    scheduledLocal: scheduledHHMM(),
    lastRunAt: state.lastRunAt,
    reclaimedBytes: state.reclaimedBytes,
    durationMs: state.durationMs,
    error: state.error,
    source: state.source || null,
    running,
  };
}

module.exports = { start, stop, runNow, snapshot, isEnabled };
