'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('./logger');

const { getCpu } = require('./collectors/cpu');
const { getMemory } = require('./collectors/memory');
const { getNetwork } = require('./collectors/network');
const { getDisks } = require('./collectors/disks');
const { getDiskIO } = require('./collectors/diskio');
const { getConnections } = require('./collectors/connections');

const DB_PATH = process.env.OTHONI_DB || path.join(__dirname, '..', 'data', 'othoni.db');
const SAMPLE_INTERVAL_MS = parseInt(process.env.OTHONI_SAMPLE_MS || '5000', 10);
const RETENTION_MS = parseInt(process.env.OTHONI_RETENTION_MS || String(24 * 60 * 60 * 1000), 10);
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Metrics we track. Each entry maps a metric name to a function that produces
// its current value from the (already-collected) snapshot. Per-core CPU is
// emitted dynamically (one metric per core) — see takeSample.
const METRICS = {
  // Composite gauges (percent)
  cpu: (s) => s.cpu?.usage,
  mem: (s) => s.memory?.usagePercent,
  swap: (s) => (s.memory?.swapTotal ? s.memory.swapPercent : null),
  load1: (s) => s.cpu?.loadAverage?.[0],
  disk_root: (s) => s.diskRoot,

  // CPU breakdown (percent)
  'cpu.user': (s) => s.cpu?.user,
  'cpu.system': (s) => s.cpu?.system,
  'cpu.idle': (s) => s.cpu?.idle,

  // Memory breakdown (bytes)
  'mem.active': (s) => s.memory?.active,
  'mem.cached': (s) => s.memory?.cached,
  'mem.buffers': (s) => s.memory?.buffers,
  'mem.free': (s) => s.memory?.free,

  // Network (bytes/sec, summed across non-loopback interfaces)
  net_rx: (s) => s.netRx,
  net_tx: (s) => s.netTx,

  // Disk I/O (bytes/sec, summed across physical block devices)
  'disk.read': (s) => s.diskReadBps,
  'disk.write': (s) => s.diskWriteBps,

  // Connections (counts from /proc/net/{tcp,tcp6,udp,udp6}). Sampled even
  // without OTHONI_LOGS_ENABLED — the connections collector is always on.
  'conn.established': (s) => s.connEstablished,
  'conn.timewait': (s) => s.connTimeWait,
  'conn.listening': (s) => s.connListening,
  'conn.total': (s) => s.connTotal,
};

// Built once per process. Variable-cardinality metrics (per-core CPU, per-iface
// network, per-disk I/O, externally-pushed `custom.*`) are validated against
// patterns rather than the static map.
const STATIC_METRICS = new Set(Object.keys(METRICS));
const CUSTOM_METRIC_PATTERN = /^custom\.[A-Za-z0-9._-]{1,128}$/;
// Synthetic checks emit two series per check: `check.<id>.up` (1 or 0) and
// `check.<id>.latency_ms` (number). Internally generated, not exposed via
// /api/metrics ingestion.
const CHECK_METRIC_PATTERN = /^check\.[A-Za-z0-9_-]{1,64}\.(up|latency_ms)$/;
const DYNAMIC_METRIC_PATTERNS = [
  /^cpu\.core\.\d+$/,
  /^net\.iface\.[A-Za-z0-9_.-]+\.(rx|tx)$/,
  /^disk\.dev\.[A-Za-z0-9_-]+\.(read|write)$/,
  CUSTOM_METRIC_PATTERN,
  CHECK_METRIC_PATTERN,
];
function isValidMetric(name) {
  if (STATIC_METRICS.has(name)) return true;
  return DYNAMIC_METRIC_PATTERNS.some((re) => re.test(name));
}
// Exposed separately so the /api/metrics ingestion route can validate
// names without importing the broader `isValidMetric` (which would also
// accept `cpu`, `mem`, etc. and let an external agent overwrite a
// built-in series).
function isCustomMetric(name) {
  return typeof name === 'string' && CUSTOM_METRIC_PATTERN.test(name);
}

// Skip veth* (Docker-created container-side bridge halves — they churn and
// would leave thousands of orphan series in the DB). Loopback is also skipped.
function isHistorableIface(name) {
  return name !== 'lo' && !/^veth/.test(name);
}

const RANGES = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

let db = null;
let sampleTimer = null;
let cleanupTimer = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function open() {
  if (db) return db;
  ensureDir(DB_PATH);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      metric TEXT NOT NULL,
      t INTEGER NOT NULL,
      v REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_metric_t ON samples(metric, t);

    CREATE TABLE IF NOT EXISTS process_samples (
      t    INTEGER NOT NULL,
      name TEXT    NOT NULL,
      pid  INTEGER,
      cpu  REAL    NOT NULL,
      mem  REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proc_samples_t      ON process_samples(t);
    CREATE INDEX IF NOT EXISTS idx_proc_samples_name_t ON process_samples(name, t);
  `);
  return db;
}

const insertStmt = () =>
  open().prepare('INSERT INTO samples (metric, t, v) VALUES (?, ?, ?)');

async function takeSample() {
  const t = Date.now();
  const [cpu, memory, network, disks, diskio, connections] = await Promise.all([
    getCpu().catch((e) => (logger.warn('history cpu:', e.message), null)),
    getMemory().catch((e) => (logger.warn('history mem:', e.message), null)),
    getNetwork().catch((e) => (logger.warn('history net:', e.message), null)),
    getDisks().catch((e) => (logger.warn('history disk:', e.message), null)),
    getDiskIO().catch((e) => (logger.warn('history diskio:', e.message), null)),
    getConnections().catch((e) => (logger.warn('history conn:', e.message), null)),
  ]);

  const nonLo = (network?.interfaces || []).filter((i) => !i.isLoopback);
  const netRx = nonLo.reduce((s, i) => s + (i.rxBytesPerSec || 0), 0);
  const netTx = nonLo.reduce((s, i) => s + (i.txBytesPerSec || 0), 0);
  const root = (disks?.disks || []).find((d) => d.mount === '/') || (disks?.disks || [])[0];
  const diskRoot = root?.usagePercent;
  const diskReadBps = diskio?.totalReadBytesPerSec;
  const diskWriteBps = diskio?.totalWriteBytesPerSec;
  const cs = connections?.summary;
  const connEstablished = cs?.established;
  const connTimeWait = cs?.timeWait;
  const connListening = cs?.listening;
  const connTotal = cs ? (cs.tcp4 + cs.tcp6 + cs.udp4 + cs.udp6) : null;

  const snapshot = {
    cpu, memory, netRx, netTx, diskRoot, diskReadBps, diskWriteBps,
    connEstablished, connTimeWait, connListening, connTotal,
  };

  const rows = [];
  for (const [name, fn] of Object.entries(METRICS)) {
    const v = fn(snapshot);
    if (v != null && Number.isFinite(v)) rows.push({ metric: name, t, v });
  }
  // Per-core CPU (variable cardinality — one metric per logical core)
  for (let i = 0; i < (cpu?.cores?.length || 0); i++) {
    const v = cpu.cores[i]?.load;
    if (v != null && Number.isFinite(v)) {
      rows.push({ metric: `cpu.core.${i}`, t, v });
    }
  }
  // Per-interface network (skip lo + veth*)
  for (const it of network?.interfaces || []) {
    if (!isHistorableIface(it.name)) continue;
    if (Number.isFinite(it.rxBytesPerSec)) {
      rows.push({ metric: `net.iface.${it.name}.rx`, t, v: it.rxBytesPerSec });
    }
    if (Number.isFinite(it.txBytesPerSec)) {
      rows.push({ metric: `net.iface.${it.name}.tx`, t, v: it.txBytesPerSec });
    }
  }
  // Per-disk I/O (collector already restricts to physical block devices)
  for (const d of diskio?.devices || []) {
    if (Number.isFinite(d.readBytesPerSec)) {
      rows.push({ metric: `disk.dev.${d.name}.read`, t, v: d.readBytesPerSec });
    }
    if (Number.isFinite(d.writeBytesPerSec)) {
      rows.push({ metric: `disk.dev.${d.name}.write`, t, v: d.writeBytesPerSec });
    }
  }

  if (rows.length) {
    const tx = db.transaction((items) => {
      const stmt = insertStmt();
      for (const r of items) stmt.run(r.metric, r.t, r.v);
    });
    tx(rows);
  }
}

function cleanup() {
  const cutoff = Date.now() - RETENTION_MS;
  const info = open().prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
  const pinfo = open().prepare('DELETE FROM process_samples WHERE t < ?').run(cutoff);
  const total = info.changes + pinfo.changes;
  if (total > 0) {
    logger.debug(`history: pruned ${info.changes} samples + ${pinfo.changes} process_samples`);
  }
}

function start() {
  open();
  // First sample shortly after startup so users see fresh data quickly.
  setTimeout(() => takeSample().catch((e) => logger.warn('sample failed:', e.message)), 1500);
  sampleTimer = setInterval(
    () => takeSample().catch((e) => logger.warn('sample failed:', e.message)),
    SAMPLE_INTERVAL_MS
  );
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  logger.info(
    `history: sampling every ${SAMPLE_INTERVAL_MS}ms, retaining ${Math.round(RETENTION_MS / 3600000)}h, db=${DB_PATH}`
  );
}

function stop() {
  if (sampleTimer) clearInterval(sampleTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (db) db.close();
  db = null;
  sampleTimer = null;
  cleanupTimer = null;
}

// Query helper. Downsamples to ~maxPoints by averaging within fixed-width
// time buckets, so the response stays small regardless of range.
function query({ metric, range = '1h', maxPoints = 500 }) {
  if (!isValidMetric(metric)) {
    const err = new Error(`unknown metric: ${metric}`);
    err.code = 'unknown_metric';
    throw err;
  }
  const span = RANGES[range] || RANGES['1h'];
  const now = Date.now();
  const from = now - span;
  const bucket = Math.max(1000, Math.floor(span / maxPoints));
  const rows = open()
    .prepare(
      `SELECT (t / ?) * ? AS t, AVG(v) AS v
       FROM samples
       WHERE metric = ? AND t >= ?
       GROUP BY t
       ORDER BY t ASC`
    )
    .all(bucket, bucket, metric, from);
  return {
    metric,
    range,
    bucketMs: bucket,
    from,
    to: now,
    points: rows.map((r) => ({ t: r.t, v: Math.round(r.v * 100) / 100 })),
  };
}

// Insert a single sample. Used by the external metrics ingestion endpoint
// (POST /api/metrics) for `custom.*` series. Returns the row that was
// inserted. Throws if the metric name doesn't match the custom pattern.
function insertCustom(name, value, t = Date.now()) {
  if (!isCustomMetric(name)) {
    const e = new Error(`metric must match ${CUSTOM_METRIC_PATTERN}`);
    e.code = 'invalid_metric';
    throw e;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const e = new Error('value must be a finite number');
    e.code = 'invalid_value';
    throw e;
  }
  const ts = Number.isFinite(t) ? Math.floor(t) : Date.now();
  open();
  insertStmt().run(name, ts, value);
  return { metric: name, t: ts, v: value };
}

// Batch variant — wraps multiple inserts in a single SQLite transaction.
// Validates ALL rows up front so a partial batch never lands.
function insertCustomBatch(rows) {
  for (const r of rows) {
    if (!isCustomMetric(r.name)) {
      const e = new Error(`metric must match ${CUSTOM_METRIC_PATTERN} (got "${r.name}")`);
      e.code = 'invalid_metric';
      throw e;
    }
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
      const e = new Error(`value must be a finite number (metric "${r.name}")`);
      e.code = 'invalid_value';
      throw e;
    }
  }
  open();
  const stmt = insertStmt();
  const tx = db.transaction((items) => {
    for (const r of items) {
      const ts = Number.isFinite(r.t) ? Math.floor(r.t) : Date.now();
      stmt.run(r.name, ts, r.value);
    }
  });
  tx(rows);
  return rows.length;
}

// List the distinct metric names currently in the samples table. The
// History page uses this to auto-discover `custom.*` series after the
// admin starts pushing them. Cheap given the indexed (metric, t) layout.
function listMetrics({ prefix } = {}) {
  open();
  const sql = prefix
    ? 'SELECT DISTINCT metric FROM samples WHERE metric LIKE ? ORDER BY metric ASC'
    : 'SELECT DISTINCT metric FROM samples ORDER BY metric ASC';
  const rows = prefix ? db.prepare(sql).all(`${prefix}%`) : db.prepare(sql).all();
  return rows.map((r) => r.metric);
}

// Trusted internal-only insert. Validates against the broader `isValidMetric`
// (so it accepts cpu.core.*, check.*, etc.) instead of just the custom-only
// pattern. Used by server/checks.js to push synthetic-check samples.
function insertSample(metric, value, t = Date.now()) {
  if (!isValidMetric(metric)) {
    const e = new Error(`unknown metric: ${metric}`);
    e.code = 'unknown_metric';
    throw e;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const e = new Error('value must be a finite number');
    e.code = 'invalid_value';
    throw e;
  }
  open();
  insertStmt().run(metric, Number.isFinite(t) ? Math.floor(t) : Date.now(), value);
}

// Exposed so sibling modules (e.g. process-history.js) can share the same
// SQLite handle / WAL session instead of opening a second connection.
function getDb() {
  return open();
}

module.exports = {
  start,
  stop,
  query,
  RANGES,
  RETENTION_MS,
  isCustomMetric,
  insertCustom,
  insertCustomBatch,
  insertSample,
  listMetrics,
  getDb,
};
