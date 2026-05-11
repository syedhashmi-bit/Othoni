'use strict';

// Server-side alert engine. Used to be client-side (localStorage + browser
// poller) but moved here in v0.11.0 so webhooks can fire even when no
// browser is open. The client now just reads `/api/alerts/active` and uses
// the existing /api/alerts/rules CRUD to manage rules.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const history = require('./history');

const { getCpu } = require('./collectors/cpu');
const { getMemory } = require('./collectors/memory');
const { getNetwork } = require('./collectors/network');
const { getDisks } = require('./collectors/disks');
const { getDiskIO } = require('./collectors/diskio');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'alert-rules.json');
const STATE_FILE = process.env.OTHONI_ALERT_RULES_PATH || DEFAULT_PATH;
const TICK_MS = 10_000;

// Metric definitions — kept in lockstep with client/src/alerts.js so the
// UI labels and the server evaluator agree on what each metric means.
// `historyKey` maps the rule's metric key onto the history.samples
// metric name used by rate-comparator evaluation; for most metrics it's
// the same string, but disk_read/disk_write are dotted in the store.
const METRICS = {
  cpu:        { label: 'CPU usage (%)',       unit: '%',   extract: (s) => s.cpu?.usage ?? null,            format: pct,  historyKey: 'cpu' },
  mem:        { label: 'Memory usage (%)',    unit: '%',   extract: (s) => s.memory?.usagePercent ?? null,  format: pct,  historyKey: 'mem' },
  swap:       { label: 'Swap usage (%)',      unit: '%',   extract: (s) => (s.memory?.swapTotal ? s.memory.swapPercent : null), format: pct, historyKey: 'swap' },
  load1:      { label: 'Load average (1m)',   unit: '',    extract: (s) => s.cpu?.loadAverage?.[0] ?? null, format: num2, historyKey: 'load1' },
  disk_root:  { label: 'Root disk usage (%)', unit: '%',   extract: (s) => rootDisk(s)?.usagePercent ?? null, format: pct, historyKey: 'disk_root' },
  net_rx:     { label: 'Network in (B/s)',    unit: 'B/s', extract: (s) => sumNonLoopback(s.network, 'rxBytesPerSec'), format: rate, historyKey: 'net_rx' },
  net_tx:     { label: 'Network out (B/s)',   unit: 'B/s', extract: (s) => sumNonLoopback(s.network, 'txBytesPerSec'), format: rate, historyKey: 'net_tx' },
  disk_read:  { label: 'Disk read (B/s)',     unit: 'B/s', extract: (s) => s.diskio?.totalReadBytesPerSec ?? null,     format: rate, historyKey: 'disk.read' },
  disk_write: { label: 'Disk write (B/s)',    unit: 'B/s', extract: (s) => s.diskio?.totalWriteBytesPerSec ?? null,    format: rate, historyKey: 'disk.write' },
};

// Rate-comparator support. The value compared against the threshold is
// the change-per-minute of the metric over `rateWindowMs`. Slope is
// computed as (last - first) / (last.t - first.t in minutes) from the
// in-process samples table.
const COMPARATORS = new Set(['gt', 'lt', 'rate_gt', 'rate_lt']);
const RATE_COMPARATORS = new Set(['rate_gt', 'rate_lt']);
const MIN_RATE_WINDOW_MS = 60_000;
const MAX_RATE_WINDOW_MS = 60 * 60_000;
const DEFAULT_RATE_WINDOW_MS = 5 * 60_000;

function isRateComparator(c) { return RATE_COMPARATORS.has(c); }

function formatRateValue(meta, ratePerMin) {
  if (ratePerMin == null || !Number.isFinite(ratePerMin)) return '—';
  const sign = ratePerMin >= 0 ? '+' : '';
  const abs = Math.abs(ratePerMin);
  if (meta.unit === '%') return `${sign}${ratePerMin.toFixed(2)}%/min`;
  if (meta.unit === 'B/s') return `${sign}${rate(abs)}/min`.replace('+-', '−');
  return `${sign}${ratePerMin.toFixed(2)}/min`;
}

function pct(v) { return `${v.toFixed(1)}%`; }
function num2(v) { return v.toFixed(2); }
function rate(v) {
  if (v == null) return '—';
  if (v < 1024) return `${v.toFixed(0)} B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}
function rootDisk(s) {
  return (s.disks?.disks || []).find((d) => d.mount === '/') || (s.disks?.disks || [])[0];
}
function sumNonLoopback(network, key) {
  const list = network?.interfaces || [];
  if (!list.length) return null;
  return list.filter((i) => !i.isLoopback).reduce((acc, i) => acc + (i[key] || 0), 0);
}

function listMetrics() {
  return Object.entries(METRICS).map(([k, m]) => ({ key: k, label: m.label, unit: m.unit }));
}

// ---------- rule CRUD ----------

let rules = null;       // [{ id, enabled, metric, comparator, threshold, durationMs, severity, label }]
let state = {};         // { ruleId: { firstBreachAt, firing, lastValue } }
let activeCache = [];   // last-computed view-model
let timer = null;
let dispatcher = null;  // injected by index.js — function to call on fire

function isValidRule(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.id !== 'string') return false;
  if (!METRICS[r.metric]) return false;
  if (!COMPARATORS.has(r.comparator)) return false;
  if (typeof r.threshold !== 'number' || !Number.isFinite(r.threshold)) return false;
  if (typeof r.durationMs !== 'number' || r.durationMs < 0) return false;
  if (r.severity !== 'warn' && r.severity !== 'crit') return false;
  // rateWindowMs is optional — fall through to default at evaluation time
  // when missing. When present, validate.
  if (r.rateWindowMs != null) {
    if (typeof r.rateWindowMs !== 'number' || !Number.isFinite(r.rateWindowMs)) return false;
    if (r.rateWindowMs < MIN_RATE_WINDOW_MS || r.rateWindowMs > MAX_RATE_WINDOW_MS) return false;
  }
  return true;
}

function newRuleId() { return crypto.randomBytes(4).toString('hex'); }

function defaultRules() {
  return [
    { id: newRuleId(), enabled: true, metric: 'cpu',       comparator: 'gt', threshold: 90, durationMs: 5*60_000, severity: 'warn', label: 'CPU sustained high' },
    { id: newRuleId(), enabled: true, metric: 'mem',       comparator: 'gt', threshold: 90, durationMs: 5*60_000, severity: 'crit', label: 'Memory pressure' },
    { id: newRuleId(), enabled: true, metric: 'disk_root', comparator: 'gt', threshold: 90, durationMs: 60_000,   severity: 'crit', label: 'Root disk almost full' },
  ];
}

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (rules !== null) return rules;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    rules = Array.isArray(parsed) ? parsed.filter(isValidRule) : [];
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`alerts: read failed (${e.message}); seeding defaults`);
    rules = defaultRules();
    persist();
  }
  return rules;
}

function persist() {
  ensureDir(STATE_FILE);
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function getRules() { return load().slice(); }

// Replace the entire rules list. Each rule the caller hands us is validated;
// invalid ones are dropped (with a warning). Existing per-rule firing state
// is preserved by id so a rule edit doesn't reset its `sustained` clock.
function setRules(next) {
  load();
  if (!Array.isArray(next)) throw Object.assign(new Error('expected array'), { code: 'invalid_request' });
  // Auto-assign id if caller omitted one (UI may add a fresh row).
  const cleaned = next.map((r) => ({ ...r, id: r.id || newRuleId() })).filter((r) => {
    if (!isValidRule(r)) {
      logger.warn(`alerts: dropped invalid rule: ${JSON.stringify(r).slice(0, 200)}`);
      return false;
    }
    return true;
  });
  rules = cleaned;
  // Drop firing state for rules that no longer exist.
  const keep = new Set(cleaned.map((r) => r.id));
  for (const id of Object.keys(state)) if (!keep.has(id)) delete state[id];
  persist();
  return cleaned;
}

// ---------- evaluator ----------

async function snapshot() {
  const [cpu, memory, network, disks, diskio] = await Promise.all([
    getCpu().catch(() => null),
    getMemory().catch(() => null),
    getNetwork().catch(() => null),
    getDisks().catch(() => null),
    getDiskIO().catch(() => null),
  ]);
  return { cpu, memory, network, disks, diskio };
}

// Compute the change-per-minute of `metric` over `windowMs` using the
// in-process samples table. Returns null if fewer than 2 samples or the
// timestamps span 0ms. Naive endpoint-to-endpoint slope rather than a
// linear regression — the existing 5s sampling cadence makes the two
// approaches indistinguishable in practice and the endpoint version is
// trivially cheap (single SELECT, two rows).
function rateAt(metricKey, windowMs, now) {
  const meta = METRICS[metricKey];
  if (!meta) return null;
  const histKey = meta.historyKey || metricKey;
  const from = now - windowMs;
  const db = history.getDb();
  // First and last sample in the window — SQLite picks them off the
  // (metric, t) index without scanning the body.
  const first = db.prepare(
    `SELECT t, v FROM samples WHERE metric = ? AND t >= ? ORDER BY t ASC LIMIT 1`
  ).get(histKey, from);
  if (!first) return null;
  const last = db.prepare(
    `SELECT t, v FROM samples WHERE metric = ? AND t >= ? ORDER BY t DESC LIMIT 1`
  ).get(histKey, from);
  if (!last || last.t === first.t) return null;
  const minutes = (last.t - first.t) / 60_000;
  if (minutes <= 0) return null;
  return (last.v - first.v) / minutes;
}

async function tick() {
  load();
  if (rules.length === 0) { activeCache = []; return; }
  let snap;
  try { snap = await snapshot(); }
  catch (e) { logger.warn(`alerts: snapshot failed: ${e.message}`); return; }

  const now = Date.now();
  const fires = [];
  for (const rule of rules) {
    const prev = state[rule.id] || { firstBreachAt: null, firing: false, lastValue: null };
    if (!rule.enabled) {
      state[rule.id] = { firstBreachAt: null, firing: false, lastValue: prev.lastValue };
      continue;
    }
    const meta = METRICS[rule.metric];
    const isRate = isRateComparator(rule.comparator);
    let value;
    if (isRate) {
      const windowMs = Math.min(
        MAX_RATE_WINDOW_MS,
        Math.max(MIN_RATE_WINDOW_MS, rule.rateWindowMs || DEFAULT_RATE_WINDOW_MS)
      );
      value = rateAt(rule.metric, windowMs, now);
    } else {
      value = meta.extract(snap);
    }
    if (value == null) {
      state[rule.id] = { firstBreachAt: null, firing: false, lastValue: null };
      continue;
    }
    let breach;
    switch (rule.comparator) {
      case 'gt':       breach = value > rule.threshold; break;
      case 'lt':       breach = value < rule.threshold; break;
      case 'rate_gt':  breach = value > rule.threshold; break;
      case 'rate_lt':  breach = value < rule.threshold; break;
      default:         breach = false;
    }
    if (!breach) {
      state[rule.id] = { firstBreachAt: null, firing: false, lastValue: value };
      continue;
    }
    const firstBreachAt = prev.firstBreachAt ?? now;
    const firing = (now - firstBreachAt) >= rule.durationMs;
    state[rule.id] = { firstBreachAt, firing, lastValue: value };
    if (firing && !prev.firing) {
      const valueFmt = isRate ? formatRateValue(meta, value) : meta.format(value);
      const thresholdFmt = isRate ? formatRateValue(meta, rule.threshold) : meta.format(rule.threshold);
      fires.push({
        rule,
        value,
        valueFmt,
        thresholdFmt,
        sustainedFor: now - firstBreachAt,
      });
    }
  }

  activeCache = projectActive();
  if (fires.length) {
    // Persist to alert_fires for the history view. Denormalize label/severity
    // so historical rows still render correctly after rule edits/deletes.
    try { recordFires(now, fires); }
    catch (e) { logger.warn(`alerts: persist fires failed: ${e.message}`); }
    if (typeof dispatcher === 'function') {
      for (const f of fires) {
        try { dispatcher(f); }
        catch (e) { logger.warn(`alerts: dispatcher threw: ${e.message}`); }
      }
    }
  }
}

function recordFires(t, fires) {
  const db = history.getDb();
  const stmt = db.prepare(
    `INSERT INTO alert_fires (t, rule_id, metric, severity, label, value, threshold, sustained_ms, comparator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows) => {
    for (const f of rows) {
      stmt.run(
        t,
        f.rule.id,
        f.rule.metric,
        f.rule.severity,
        f.rule.label || '',
        f.value,
        f.rule.threshold,
        f.sustainedFor,
        f.rule.comparator || null
      );
    }
  });
  tx(fires);
}

function projectActive() {
  const out = [];
  for (const rule of rules) {
    const s = state[rule.id];
    if (!s || !s.firing) continue;
    const meta = METRICS[rule.metric];
    const isRate = isRateComparator(rule.comparator);
    out.push({
      id: rule.id,
      label: rule.label,
      metric: rule.metric,
      metricLabel: meta.label,
      comparator: rule.comparator,
      threshold: rule.threshold,
      thresholdFmt: isRate ? formatRateValue(meta, rule.threshold) : meta.format(rule.threshold),
      severity: rule.severity,
      value: s.lastValue,
      valueFmt: isRate ? formatRateValue(meta, s.lastValue) : meta.format(s.lastValue),
      sustainedFor: Date.now() - (s.firstBreachAt || Date.now()),
    });
  }
  out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'crit' ? -1 : 1;
    return (a.label || a.metric).localeCompare(b.label || b.metric);
  });
  return out;
}

function getActive() { return projectActive(); }

function setDispatcher(fn) { dispatcher = fn; }

// ---------- alert history ----------

const HISTORY_RANGES = {
  '1h':  60 * 60 * 1000,
  '6h':  6  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

// Per-rule stats over the requested range, plus a small density histogram
// (count of fires per fixed-width bucket) suitable for a sparkline. Returns
// stats for ALL rules that have fired in the range — including rules that
// have since been deleted, so the UI can show "(deleted) Foo" rows. The
// rules-table render layer joins this against the current rule list.
function getStats({ range = '24h', buckets = 24 } = {}) {
  const span = HISTORY_RANGES[range] || HISTORY_RANGES['24h'];
  const now  = Date.now();
  const from = now - span;
  const db   = history.getDb();

  const totals = db.prepare(
    `SELECT rule_id,
            COUNT(*) AS fires,
            MAX(t)   AS lastFiredAt,
            MAX(severity) AS lastSeverity
       FROM alert_fires
      WHERE t >= ?
      GROUP BY rule_id`
  ).all(from);

  const bucketMs = Math.max(60_000, Math.floor(span / Math.max(4, buckets)));
  const sparkStmt = db.prepare(
    `SELECT (t / ?) * ? AS t, COUNT(*) AS v
       FROM alert_fires
      WHERE rule_id = ? AND t >= ?
      GROUP BY (t / ?)
      ORDER BY t ASC`
  );

  const byRule = {};
  for (const row of totals) {
    const points = sparkStmt.all(bucketMs, bucketMs, row.rule_id, from, bucketMs);
    byRule[row.rule_id] = {
      fires:        row.fires,
      lastFiredAt:  row.lastFiredAt,
      lastSeverity: row.lastSeverity,
      points,
    };
  }

  return { range, from, to: now, bucketMs, byRule };
}

// Recent fires timeline. Includes denormalized label/severity so rows still
// render after rule deletions. `limit` capped server-side.
function listFires({ range = '24h', limit = 100 } = {}) {
  const span = HISTORY_RANGES[range] || HISTORY_RANGES['24h'];
  const now  = Date.now();
  const from = now - span;
  const cap  = Math.min(500, Math.max(1, limit | 0 || 100));
  const rows = history.getDb().prepare(
    `SELECT t, rule_id AS ruleId, metric, severity, label, value, threshold, sustained_ms AS sustainedMs, comparator
       FROM alert_fires
      WHERE t >= ?
      ORDER BY t DESC
      LIMIT ?`
  ).all(from, cap);

  // Build value/threshold formatters using the current METRICS map. If the
  // metric is no longer in the map (unlikely but possible) fall back to raw.
  // Rows fired before v0.29.0 have comparator=NULL — treat them as instant
  // (gt/lt) and use the metric's standard formatter.
  return {
    range, from, to: now, count: rows.length,
    fires: rows.map((r) => {
      const meta = METRICS[r.metric];
      const isRate = isRateComparator(r.comparator);
      const fmt = (v) => {
        if (!meta || v == null) return v != null ? String(v) : null;
        return isRate ? formatRateValue(meta, v) : meta.format(v);
      };
      return {
        ...r,
        valueFmt:     fmt(r.value),
        thresholdFmt: fmt(r.threshold),
      };
    }),
  };
}

function start() {
  load();
  // Run the first tick shortly after startup so the active list is populated
  // before the first poll lands.
  setTimeout(() => tick().catch((e) => logger.warn(`alerts tick failed: ${e.message}`)), 2000);
  timer = setInterval(() => tick().catch((e) => logger.warn(`alerts tick failed: ${e.message}`)), TICK_MS);
  logger.info(`alerts: server-side engine started, ${rules.length} rule(s), tick=${TICK_MS}ms`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function reset() {
  rules = null;
  state = {};
  activeCache = [];
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  start, stop, reset,
  getRules, setRules,
  getActive,
  getStats, listFires,
  setDispatcher,
  listMetrics,
  // exported for tests / introspection
  _tick: tick,
};
