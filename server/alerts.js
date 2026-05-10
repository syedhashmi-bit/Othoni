'use strict';

// Server-side alert engine. Used to be client-side (localStorage + browser
// poller) but moved here in v0.11.0 so webhooks can fire even when no
// browser is open. The client now just reads `/api/alerts/active` and uses
// the existing /api/alerts/rules CRUD to manage rules.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

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
const METRICS = {
  cpu:        { label: 'CPU usage (%)',       unit: '%',   extract: (s) => s.cpu?.usage ?? null,            format: pct },
  mem:        { label: 'Memory usage (%)',    unit: '%',   extract: (s) => s.memory?.usagePercent ?? null,  format: pct },
  swap:       { label: 'Swap usage (%)',      unit: '%',   extract: (s) => (s.memory?.swapTotal ? s.memory.swapPercent : null), format: pct },
  load1:      { label: 'Load average (1m)',   unit: '',    extract: (s) => s.cpu?.loadAverage?.[0] ?? null, format: num2 },
  disk_root:  { label: 'Root disk usage (%)', unit: '%',   extract: (s) => rootDisk(s)?.usagePercent ?? null, format: pct },
  net_rx:     { label: 'Network in (B/s)',    unit: 'B/s', extract: (s) => sumNonLoopback(s.network, 'rxBytesPerSec'), format: rate },
  net_tx:     { label: 'Network out (B/s)',   unit: 'B/s', extract: (s) => sumNonLoopback(s.network, 'txBytesPerSec'), format: rate },
  disk_read:  { label: 'Disk read (B/s)',     unit: 'B/s', extract: (s) => s.diskio?.totalReadBytesPerSec ?? null,     format: rate },
  disk_write: { label: 'Disk write (B/s)',    unit: 'B/s', extract: (s) => s.diskio?.totalWriteBytesPerSec ?? null,    format: rate },
};

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
  return r && typeof r === 'object'
    && typeof r.id === 'string'
    && METRICS[r.metric]
    && (r.comparator === 'gt' || r.comparator === 'lt')
    && typeof r.threshold === 'number' && Number.isFinite(r.threshold)
    && typeof r.durationMs === 'number' && r.durationMs >= 0
    && (r.severity === 'warn' || r.severity === 'crit');
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
    const value = meta.extract(snap);
    if (value == null) {
      state[rule.id] = { firstBreachAt: null, firing: false, lastValue: null };
      continue;
    }
    const breach = rule.comparator === 'gt' ? value > rule.threshold : value < rule.threshold;
    if (!breach) {
      state[rule.id] = { firstBreachAt: null, firing: false, lastValue: value };
      continue;
    }
    const firstBreachAt = prev.firstBreachAt ?? now;
    const firing = (now - firstBreachAt) >= rule.durationMs;
    state[rule.id] = { firstBreachAt, firing, lastValue: value };
    if (firing && !prev.firing) {
      fires.push({
        rule,
        value,
        valueFmt:     meta.format(value),
        thresholdFmt: meta.format(rule.threshold),
        sustainedFor: now - firstBreachAt,
      });
    }
  }

  activeCache = projectActive();
  if (fires.length && typeof dispatcher === 'function') {
    for (const f of fires) {
      try { dispatcher(f); }
      catch (e) { logger.warn(`alerts: dispatcher threw: ${e.message}`); }
    }
  }
}

function projectActive() {
  const out = [];
  for (const rule of rules) {
    const s = state[rule.id];
    if (!s || !s.firing) continue;
    out.push({
      id: rule.id,
      label: rule.label,
      metric: rule.metric,
      metricLabel: METRICS[rule.metric].label,
      comparator: rule.comparator,
      threshold: rule.threshold,
      thresholdFmt: METRICS[rule.metric].format(rule.threshold),
      severity: rule.severity,
      value: s.lastValue,
      valueFmt: METRICS[rule.metric].format(s.lastValue),
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
  setDispatcher,
  listMetrics,
  // exported for tests / introspection
  _tick: tick,
};
