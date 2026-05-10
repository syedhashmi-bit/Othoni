'use strict';

// Synthetic checks — periodic active probes (HTTP, TCP, ICMP ping). Each
// check produces two samples per run into the SQLite history store
// (`check.<id>.up` ∈ {0, 1}, `check.<id>.latency_ms` ≥ 0) so they show up
// on the History page like everything else. Consecutive failures dispatch
// to the same webhook destinations as threshold alerts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');
const logger = require('./logger');
const history = require('./history');

const STORE_PATH = process.env.OTHONI_CHECKS_PATH || path.join(__dirname, '..', 'data', 'checks.json');
const VALID_TYPES = ['http', 'tcp', 'ping'];
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 24 * 3600;

let cache = null;            // { checks: [...] }
let timers = new Map();      // id -> intervalHandle
let dispatcher = null;       // injected by index.js — same as alerts uses

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && Array.isArray(parsed.checks) ? parsed : { checks: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`checks: read failed (${e.message}); starting fresh`);
    cache = { checks: [] };
  }
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function newId() { return crypto.randomBytes(4).toString('hex'); }

function setDispatcher(fn) { dispatcher = fn; }

// ---------- validation ----------

function validateTarget(type, target) {
  if (typeof target !== 'string' || !target) return 'target required';
  if (target.length > 1024) return 'target too long';
  if (type === 'http') {
    try {
      const u = new URL(target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http target must be http(s)://';
      if (!u.hostname) return 'http target missing hostname';
    } catch { return 'http target is not a valid URL'; }
  } else if (type === 'tcp') {
    if (!/^[A-Za-z0-9.:_-]+:\d{1,5}$/.test(target)) return 'tcp target must be host:port';
    const port = parseInt(target.split(':').pop(), 10);
    if (port < 1 || port > 65535) return 'tcp port out of range';
  } else if (type === 'ping') {
    if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(target)) return 'ping target must be a hostname or IP';
  }
  return null;
}

function sanitize(c) {
  return {
    id: c.id,
    label: c.label,
    type: c.type,
    target: c.target,
    intervalSec: c.intervalSec,
    timeoutMs: c.timeoutMs,
    enabled: c.enabled !== false,
    alertAfterFailures: c.alertAfterFailures || 0,
    alertSeverity: c.alertSeverity || 'warn',
    createdAt: c.createdAt,
    lastRunAt: c.lastRunAt || null,
    lastUp: typeof c.lastUp === 'number' ? c.lastUp : null,
    lastLatencyMs: typeof c.lastLatencyMs === 'number' ? c.lastLatencyMs : null,
    consecutiveFailures: c.consecutiveFailures || 0,
    lastError: c.lastError || null,
  };
}

// ---------- executors ----------

async function runHttp(target, timeoutMs) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'othoni-check/1' },
    });
    if (!res.ok) return { up: 0, error: `HTTP ${res.status}` };
    // Drain the body so the connection can be reused / closed cleanly.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    return { up: 1, error: null };
  } catch (e) {
    return { up: 0, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'failed') };
  } finally {
    clearTimeout(tid);
  }
}

function runTcp(target, timeoutMs) {
  return new Promise((resolve) => {
    const idx = target.lastIndexOf(':');
    const host = target.slice(0, idx);
    const port = parseInt(target.slice(idx + 1), 10);
    const s = net.connect({ host, port });
    let done = false;
    const tid = setTimeout(() => finish(0, 'timeout'), timeoutMs);
    function finish(up, error) {
      if (done) return;
      done = true;
      clearTimeout(tid);
      try { s.destroy(); } catch { /* ignore */ }
      resolve({ up, error });
    }
    s.once('connect', () => finish(1, null));
    s.once('error',   (e) => finish(0, e.code || e.message || 'failed'));
  });
}

function runPing(target, timeoutMs) {
  return new Promise((resolve) => {
    // -c 1: send one packet. -W: deadline in seconds for the reply.
    const w = Math.max(1, Math.ceil(timeoutMs / 1000));
    execFile('ping', ['-c', '1', '-W', String(w), target], { timeout: timeoutMs + 1000 }, (err, stdout, stderr) => {
      if (err) return resolve({ up: 0, error: (stderr || err.message || 'failed').toString().trim().slice(0, 120) });
      resolve({ up: 1, error: null });
    });
  });
}

async function runOnce(c) {
  const t0 = Date.now();
  let result;
  try {
    if (c.type === 'http')      result = await runHttp(c.target, c.timeoutMs);
    else if (c.type === 'tcp')  result = await runTcp(c.target,  c.timeoutMs);
    else if (c.type === 'ping') result = await runPing(c.target, c.timeoutMs);
    else                        result = { up: 0, error: 'unknown_type' };
  } catch (e) {
    result = { up: 0, error: e.message || 'failed' };
  }
  const latencyMs = Date.now() - t0;

  // Persist samples (best-effort — never throw out of the scheduler).
  try { history.insertSample(`check.${c.id}.up`, result.up); }
  catch (e) { logger.warn(`check ${c.id}: insertSample(up) failed: ${e.message}`); }
  try { history.insertSample(`check.${c.id}.latency_ms`, latencyMs); }
  catch (e) { logger.warn(`check ${c.id}: insertSample(latency) failed: ${e.message}`); }

  // Update in-memory state (and persist so the UI sees fresh fields).
  c.lastRunAt = Date.now();
  c.lastUp = result.up;
  c.lastLatencyMs = latencyMs;
  c.lastError = result.up ? null : (result.error || 'failed');
  if (result.up === 0) {
    c.consecutiveFailures = (c.consecutiveFailures || 0) + 1;
    // Fire to webhooks exactly once — at the moment we cross the threshold.
    if (
      dispatcher
      && c.alertAfterFailures > 0
      && c.consecutiveFailures === c.alertAfterFailures
    ) {
      const event = {
        rule: {
          id: `check:${c.id}`,
          label: `${c.label || c.id} is down`,
          metric: `check.${c.id}.up`,
          comparator: 'lt',
          threshold: 1,
          severity: c.alertSeverity || 'warn',
        },
        value: 0,
        valueFmt: c.lastError ? `down (${c.lastError})` : 'down',
        thresholdFmt: 'up',
        sustainedFor: c.consecutiveFailures * (c.intervalSec * 1000),
      };
      try { dispatcher(event); }
      catch (e) { logger.warn(`check ${c.id}: dispatch failed: ${e.message}`); }
    }
  } else {
    c.consecutiveFailures = 0;
  }
  persist();
}

// ---------- scheduler ----------

function clearAll() {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
}

function scheduleOne(c) {
  if (!c.enabled) return;
  const interval = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, c.intervalSec || 60)) * 1000;
  // First run a couple seconds after scheduling so the user sees state quickly.
  setTimeout(() => runOnce(c).catch(() => {}), 2000 + Math.random() * 1500);
  const id = setInterval(() => runOnce(c).catch(() => {}), interval);
  timers.set(c.id, id);
}

function rescheduleAll() {
  clearAll();
  for (const c of cache.checks) scheduleOne(c);
}

function start() {
  load();
  rescheduleAll();
  logger.info(`checks: ${cache.checks.length} check(s) scheduled`);
}

function stop() { clearAll(); }

function reset() { cache = null; clearAll(); }

// ---------- CRUD ----------

function listChecks() {
  load();
  return cache.checks.map(sanitize);
}

function createCheck({ label, type, target, intervalSec, timeoutMs, alertAfterFailures, alertSeverity }) {
  if (typeof label !== 'string' || !label.trim() || label.length > 80) {
    throw Object.assign(new Error('label must be 1–80 chars'), { code: 'invalid_label' });
  }
  if (!VALID_TYPES.includes(type)) {
    throw Object.assign(new Error(`type must be one of ${VALID_TYPES.join(', ')}`), { code: 'invalid_type' });
  }
  const targetErr = validateTarget(type, target);
  if (targetErr) throw Object.assign(new Error(targetErr), { code: 'invalid_target' });
  const interval = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, parseInt(intervalSec, 10) || 60));
  const timeout = Math.max(500, Math.min(60_000, parseInt(timeoutMs, 10) || 5000));
  const alertN = Math.max(0, Math.min(100, parseInt(alertAfterFailures, 10) || 0));
  const sev = alertSeverity === 'crit' ? 'crit' : 'warn';

  load();
  const c = {
    id: newId(),
    label: label.trim(),
    type,
    target,
    intervalSec: interval,
    timeoutMs: timeout,
    alertAfterFailures: alertN,
    alertSeverity: sev,
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: null,
    lastUp: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  cache.checks.push(c);
  persist();
  scheduleOne(c);
  return sanitize(c);
}

function updateCheck(id, patch) {
  load();
  const c = cache.checks.find((x) => x.id === id);
  if (!c) return null;
  if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
  if (typeof patch.label === 'string' && patch.label.trim() && patch.label.length <= 80) {
    c.label = patch.label.trim();
  }
  if (Number.isFinite(parseInt(patch.intervalSec, 10))) {
    c.intervalSec = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, parseInt(patch.intervalSec, 10)));
  }
  if (Number.isFinite(parseInt(patch.alertAfterFailures, 10))) {
    c.alertAfterFailures = Math.max(0, Math.min(100, parseInt(patch.alertAfterFailures, 10)));
  }
  if (patch.alertSeverity === 'warn' || patch.alertSeverity === 'crit') {
    c.alertSeverity = patch.alertSeverity;
  }
  persist();
  // Re-schedule this one check so interval changes take effect immediately.
  const t = timers.get(id);
  if (t) { clearInterval(t); timers.delete(id); }
  scheduleOne(c);
  return sanitize(c);
}

function removeCheck(id) {
  load();
  const before = cache.checks.length;
  cache.checks = cache.checks.filter((c) => c.id !== id);
  if (cache.checks.length === before) return false;
  const t = timers.get(id);
  if (t) { clearInterval(t); timers.delete(id); }
  persist();
  return true;
}

// One-shot synchronous run, e.g. for the "Run now" button. Returns the
// resulting state (up + latency + error).
async function runNow(id) {
  load();
  const c = cache.checks.find((x) => x.id === id);
  if (!c) return null;
  await runOnce(c);
  return sanitize(c);
}

module.exports = {
  start, stop, reset,
  setDispatcher,
  listChecks, createCheck, updateCheck, removeCheck, runNow,
};
