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
const VALID_TYPES = ['http', 'tcp', 'ping', 'dns'];
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 24 * 3600;

// Body assertion limits — keep the regex/jsonPath bounded so a malformed
// pattern can't blow up the runner. Body is also capped before scanning
// to keep memory usage predictable.
const MAX_REGEX_LEN     = 256;
const MAX_JSONPATH_LEN  = 256;
const MAX_BODY_SCAN     = 256 * 1024; // 256 KB
const REGEX_EVAL_BUDGET = 100;        // ms — RegExp eval is sync, this is best-effort

// Supported DNS record types (Node `dns` module backed).
const DNS_TYPES = new Set(['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SRV', 'PTR']);

// Multi-step HTTP — at most this many sequential requests per check run.
const MAX_HTTP_STEPS = 8;

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
  } else if (type === 'dns') {
    // Format: host[|TYPE] — TYPE defaults to A. Example: example.com|MX
    const [host, recType] = target.split('|');
    if (!host || !/^[A-Za-z0-9._-]{1,253}$/.test(host)) return 'dns target must be a hostname';
    if (recType && !DNS_TYPES.has(recType.toUpperCase())) return `dns type must be one of ${[...DNS_TYPES].join(', ')}`;
  }
  return null;
}

// Compile a user-supplied regex; returns null + reason on failure.
function compileRegex(src) {
  if (typeof src !== 'string' || !src) return { re: null };
  if (src.length > MAX_REGEX_LEN) return { re: null, error: `regex too long (max ${MAX_REGEX_LEN})` };
  try {
    return { re: new RegExp(src) };
  } catch (e) {
    return { re: null, error: `invalid regex: ${e.message}` };
  }
}

// Minimal JSON path resolver — dotted keys with bracketed indexes.
// Supports: `a.b.c`, `users[0].name`, `data["key with spaces"]`.
// Returns { found: bool, value }. Bails on the first missing key.
function resolveJsonPath(obj, pathStr) {
  if (typeof pathStr !== 'string' || !pathStr) return { found: false };
  const tokens = [];
  // Tokeniser: . segments, then bracketed forms.
  const re = /\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;
  let m;
  let consumed = 0;
  // Allow a leading `$` (jq-style) as the root anchor.
  let s = pathStr.trim();
  if (s.startsWith('$')) s = s.slice(1);
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed) return { found: false };
    consumed = re.lastIndex;
    tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  if (consumed !== s.length) return { found: false };
  let cur = obj;
  for (const tok of tokens) {
    if (cur == null) return { found: false };
    if (Array.isArray(cur)) cur = cur[parseInt(tok, 10)];
    else if (typeof cur === 'object') cur = cur[tok];
    else return { found: false };
  }
  if (cur === undefined) return { found: false };
  return { found: true, value: cur };
}

// Evaluate body-level assertions against a fetched body string.
// Returns { ok: bool, error: string|null }.
function evalBodyAssertions(body, opts) {
  const { bodyRegex, jsonPath, jsonPathEquals } = opts || {};
  if (bodyRegex) {
    const { re, error } = compileRegex(bodyRegex);
    if (!re) return { ok: false, error: error || 'invalid regex' };
    // Slice the body to keep eval bounded.
    const slice = body.length > MAX_BODY_SCAN ? body.slice(0, MAX_BODY_SCAN) : body;
    const t0 = Date.now();
    let matched;
    try { matched = re.test(slice); }
    catch (e) { return { ok: false, error: `regex error: ${e.message}` }; }
    if (Date.now() - t0 > REGEX_EVAL_BUDGET) {
      // Soft warning; still trust the result.
      logger.warn(`checks: regex took ${Date.now() - t0}ms — consider simplifying`);
    }
    if (!matched) return { ok: false, error: 'body did not match regex' };
  }
  if (jsonPath) {
    let parsed;
    try { parsed = JSON.parse(body.length > MAX_BODY_SCAN ? body.slice(0, MAX_BODY_SCAN) : body); }
    catch (e) { return { ok: false, error: `body not JSON: ${e.message}` }; }
    const { found, value } = resolveJsonPath(parsed, jsonPath);
    if (!found) return { ok: false, error: `jsonPath not found: ${jsonPath}` };
    if (jsonPathEquals != null && jsonPathEquals !== '') {
      // Compare as string so the user can write `"true"` or `"200"` without
      // worrying about JS type coercion. Numbers/booleans stringify cleanly.
      if (String(value) !== String(jsonPathEquals)) {
        return { ok: false, error: `jsonPath mismatch: ${String(value).slice(0, 80)} ≠ ${jsonPathEquals}` };
      }
    }
  }
  return { ok: true, error: null };
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
    // v0.51 — HTTP body assertions
    bodyRegex:      c.bodyRegex      || null,
    jsonPath:       c.jsonPath       || null,
    jsonPathEquals: c.jsonPathEquals || null,
    // v0.54 — multi-step HTTP. When set, `target` + body assertions on the
    // check itself are ignored in favor of the steps array.
    steps: Array.isArray(c.steps) ? c.steps : null,
    createdAt: c.createdAt,
    lastRunAt: c.lastRunAt || null,
    lastUp: typeof c.lastUp === 'number' ? c.lastUp : null,
    lastLatencyMs: typeof c.lastLatencyMs === 'number' ? c.lastLatencyMs : null,
    consecutiveFailures: c.consecutiveFailures || 0,
    lastError: c.lastError || null,
    lastStep: c.lastStep || null,
  };
}

// ---------- executors ----------

// Run a single HTTP request and optionally evaluate body-level assertions.
// `opts` may include: bodyRegex, jsonPath, jsonPathEquals, method, headers.
async function runHttpOnce(url, timeoutMs, opts = {}) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'othoni-check/1', ...(opts.headers || {}) },
    });
    if (!res.ok) return { up: 0, error: `HTTP ${res.status}` };
    // Only read the body if we have a body-level assertion to evaluate.
    // Saves the I/O + memory on plain "is the server alive" checks.
    const needsBody = !!(opts.bodyRegex || opts.jsonPath);
    if (!needsBody) {
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      return { up: 1, error: null };
    }
    let body;
    try { body = await res.text(); }
    catch (e) { return { up: 0, error: `body read failed: ${e.message}` }; }
    const r = evalBodyAssertions(body, opts);
    return r.ok ? { up: 1, error: null } : { up: 0, error: r.error };
  } catch (e) {
    return { up: 0, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'failed') };
  } finally {
    clearTimeout(tid);
  }
}

// Single-step HTTP — preserves the v0.13 shape used by every existing check.
async function runHttp(check, timeoutMs) {
  return runHttpOnce(check.target, timeoutMs, {
    bodyRegex:      check.bodyRegex,
    jsonPath:       check.jsonPath,
    jsonPathEquals: check.jsonPathEquals,
  });
}

// Multi-step HTTP chain (v0.54). Each step has its own URL + optional method,
// headers, and body-level assertion. Bails on the first failure and reports
// which step (1-indexed) tripped. The full timeoutMs is divided evenly so
// one slow step can't starve the rest.
async function runHttpChain(check, timeoutMs) {
  const steps = check.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { up: 0, error: 'no steps' };
  if (steps.length > MAX_HTTP_STEPS) return { up: 0, error: `too many steps (max ${MAX_HTTP_STEPS})` };
  const perStep = Math.max(500, Math.floor(timeoutMs / steps.length));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step.url !== 'string' || !step.url) {
      return { up: 0, error: `step ${i + 1}: missing url`, step: i + 1 };
    }
    const r = await runHttpOnce(step.url, perStep, {
      method:         step.method,
      headers:        step.headers,
      bodyRegex:      step.bodyRegex,
      jsonPath:       step.jsonPath,
      jsonPathEquals: step.jsonPathEquals,
    });
    if (r.up === 0) return { up: 0, error: `step ${i + 1}: ${r.error}`, step: i + 1 };
  }
  return { up: 1, error: null, step: steps.length };
}

// DNS check (v0.53). Target format: `host[|TYPE]`. Resolves the record and
// asserts at least one result; an optional bodyRegex matches against the
// joined result list (so "host|TXT" with bodyRegex="v=spf1" works).
const dns = require('dns').promises;
async function runDns(check, timeoutMs) {
  const [host, recTypeRaw] = check.target.split('|');
  const type = (recTypeRaw || 'A').toUpperCase();
  if (!DNS_TYPES.has(type)) return { up: 0, error: `unknown dns type ${type}` };
  // Node's dns.resolve doesn't accept a timeout — race it against a sleep.
  const work = (async () => {
    try {
      const results = await dns.resolve(host, type);
      if (!results || results.length === 0) return { up: 0, error: 'no records' };
      if (check.bodyRegex) {
        const flat = results.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
        const { re, error } = compileRegex(check.bodyRegex);
        if (!re) return { up: 0, error: error || 'invalid regex' };
        if (!re.test(flat)) return { up: 0, error: 'no record matched regex' };
      }
      return { up: 1, error: null };
    } catch (e) {
      return { up: 0, error: e.code || e.message || 'dns failed' };
    }
  })();
  const timeout = new Promise((r) => setTimeout(() => r({ up: 0, error: 'timeout' }), timeoutMs));
  return Promise.race([work, timeout]);
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
    if (c.type === 'http' && Array.isArray(c.steps) && c.steps.length > 0) {
      result = await runHttpChain(c, c.timeoutMs);
    } else if (c.type === 'http') result = await runHttp(c, c.timeoutMs);
    else if (c.type === 'tcp')    result = await runTcp(c.target,  c.timeoutMs);
    else if (c.type === 'ping')   result = await runPing(c.target, c.timeoutMs);
    else if (c.type === 'dns')    result = await runDns(c, c.timeoutMs);
    else                          result = { up: 0, error: 'unknown_type' };
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
  c.lastStep  = result.step != null ? result.step : null;
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

// Validates the body-assertion fields on a check payload. Returns null on
// success, or a message string on failure.
function validateAssertions(body) {
  if (body.bodyRegex != null) {
    if (typeof body.bodyRegex !== 'string') return 'bodyRegex must be a string';
    if (body.bodyRegex.length > MAX_REGEX_LEN) return `bodyRegex too long (max ${MAX_REGEX_LEN})`;
    const { re, error } = compileRegex(body.bodyRegex);
    if (!re && error) return error;
  }
  if (body.jsonPath != null) {
    if (typeof body.jsonPath !== 'string') return 'jsonPath must be a string';
    if (body.jsonPath.length > MAX_JSONPATH_LEN) return `jsonPath too long (max ${MAX_JSONPATH_LEN})`;
  }
  if (body.jsonPathEquals != null && typeof body.jsonPathEquals !== 'string' && typeof body.jsonPathEquals !== 'number' && typeof body.jsonPathEquals !== 'boolean') {
    return 'jsonPathEquals must be a string / number / boolean';
  }
  return null;
}

// Validates the optional `steps` array (multi-step HTTP, v0.54).
function validateSteps(steps) {
  if (steps == null) return null;
  if (!Array.isArray(steps)) return 'steps must be an array';
  if (steps.length === 0) return null; // empty == single-step mode
  if (steps.length > MAX_HTTP_STEPS) return `too many steps (max ${MAX_HTTP_STEPS})`;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return `step ${i + 1}: must be an object`;
    if (typeof s.url !== 'string' || !s.url) return `step ${i + 1}: url required`;
    try {
      const u = new URL(s.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return `step ${i + 1}: url must be http(s)`;
    } catch { return `step ${i + 1}: invalid url`; }
    if (s.method != null && !['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'].includes(s.method)) {
      return `step ${i + 1}: method must be GET/POST/PUT/DELETE/HEAD/PATCH`;
    }
    const err = validateAssertions(s);
    if (err) return `step ${i + 1}: ${err}`;
  }
  return null;
}

function createCheck(body) {
  const { label, type, target, intervalSec, timeoutMs, alertAfterFailures, alertSeverity,
          bodyRegex, jsonPath, jsonPathEquals, steps } = body;
  if (typeof label !== 'string' || !label.trim() || label.length > 80) {
    throw Object.assign(new Error('label must be 1–80 chars'), { code: 'invalid_label' });
  }
  if (!VALID_TYPES.includes(type)) {
    throw Object.assign(new Error(`type must be one of ${VALID_TYPES.join(', ')}`), { code: 'invalid_type' });
  }
  // For multi-step HTTP the `target` is unused; skip its validation.
  const usingSteps = type === 'http' && Array.isArray(steps) && steps.length > 0;
  if (!usingSteps) {
    const targetErr = validateTarget(type, target);
    if (targetErr) throw Object.assign(new Error(targetErr), { code: 'invalid_target' });
  }
  const assertErr = validateAssertions({ bodyRegex, jsonPath, jsonPathEquals });
  if (assertErr) throw Object.assign(new Error(assertErr), { code: 'invalid_assertion' });
  const stepsErr = validateSteps(steps);
  if (stepsErr) throw Object.assign(new Error(stepsErr), { code: 'invalid_steps' });

  const interval = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, parseInt(intervalSec, 10) || 60));
  const timeout = Math.max(500, Math.min(60_000, parseInt(timeoutMs, 10) || 5000));
  const alertN = Math.max(0, Math.min(100, parseInt(alertAfterFailures, 10) || 0));
  const sev = alertSeverity === 'crit' ? 'crit' : 'warn';

  load();
  const c = {
    id: newId(),
    label: label.trim(),
    type,
    target: usingSteps ? '' : target,
    intervalSec: interval,
    timeoutMs: timeout,
    alertAfterFailures: alertN,
    alertSeverity: sev,
    bodyRegex:      typeof bodyRegex      === 'string' ? bodyRegex      : null,
    jsonPath:       typeof jsonPath       === 'string' ? jsonPath       : null,
    jsonPathEquals: jsonPathEquals != null ? String(jsonPathEquals)    : null,
    steps: Array.isArray(steps) && steps.length > 0 ? steps : null,
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: null,
    lastUp: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    lastError: null,
    lastStep: null,
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
  // Body assertions — null/empty string clears the field.
  if (patch.bodyRegex !== undefined) {
    const e = validateAssertions({ bodyRegex: patch.bodyRegex });
    if (e) throw Object.assign(new Error(e), { code: 'invalid_assertion' });
    c.bodyRegex = patch.bodyRegex || null;
  }
  if (patch.jsonPath !== undefined) {
    const e = validateAssertions({ jsonPath: patch.jsonPath });
    if (e) throw Object.assign(new Error(e), { code: 'invalid_assertion' });
    c.jsonPath = patch.jsonPath || null;
  }
  if (patch.jsonPathEquals !== undefined) {
    const e = validateAssertions({ jsonPathEquals: patch.jsonPathEquals });
    if (e) throw Object.assign(new Error(e), { code: 'invalid_assertion' });
    c.jsonPathEquals = patch.jsonPathEquals == null ? null : String(patch.jsonPathEquals);
  }
  if (patch.steps !== undefined) {
    const e = validateSteps(patch.steps);
    if (e) throw Object.assign(new Error(e), { code: 'invalid_steps' });
    c.steps = Array.isArray(patch.steps) && patch.steps.length > 0 ? patch.steps : null;
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
  invalidateStats(id);
  persist();
  return true;
}

// ---------- SLA stats (v0.52) ----------
//
// Per-check latency percentiles + uptime over a configurable window. Reads
// directly from the samples table (check.<id>.latency_ms + check.<id>.up).
// Results are cached for STATS_CACHE_TTL_MS so repeated polls don't redo
// the same percentile sort.

const STATS_RANGES = {
  '15m':  15 * 60_000,
  '1h':   60 * 60_000,
  '6h':   6  * 60 * 60_000,
  '24h':  24 * 60 * 60_000,
};
const STATS_CACHE_TTL_MS = 30_000;
const statsCache = new Map(); // `${id}:${range}` -> { at, value }

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  // Nearest-rank: a simple, well-known choice. Matches what most operators
  // expect for "p95 latency" without taking on a stats library.
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function getCheckStats(id, { range = '1h' } = {}) {
  const span = STATS_RANGES[range] || STATS_RANGES['1h'];
  const key = `${id}:${range}`;
  const now = Date.now();
  const cached = statsCache.get(key);
  if (cached && now - cached.at < STATS_CACHE_TTL_MS) return cached.value;

  const from = now - span;
  const db = history.getDb();

  // Latency rows for percentiles.
  const latRows = db
    .prepare(`SELECT v FROM samples WHERE metric = ? AND t >= ? ORDER BY v ASC`)
    .all(`check.${id}.latency_ms`, from);
  const latencies = latRows.map((r) => r.v);

  // Up/down rows for uptime %. AVG would work too but doing it in JS keeps
  // the up/down totals available for the UI without a second query.
  const upRows = db
    .prepare(`SELECT v FROM samples WHERE metric = ? AND t >= ?`)
    .all(`check.${id}.up`, from);
  const total = upRows.length;
  const up = upRows.reduce((s, r) => s + (r.v ? 1 : 0), 0);

  const value = {
    id,
    range,
    samples: total,
    uptimePercent: total > 0 ? (up / total) * 100 : null,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: latencies.length ? latencies[0] : null,
    max: latencies.length ? latencies[latencies.length - 1] : null,
  };
  statsCache.set(key, { at: now, value });
  return value;
}

// Invalidate cache when a check is removed / updated.
function invalidateStats(id) {
  for (const k of statsCache.keys()) {
    if (k.startsWith(`${id}:`)) statsCache.delete(k);
  }
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
  getCheckStats,
};
