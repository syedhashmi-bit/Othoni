'use strict';

// Process trends sampler. Periodically captures the top-N processes by CPU
// (and the top memory hogs that didn't make the CPU cut) and persists them
// to the `process_samples` table created by server/history.js. Cadence is
// slower than the metrics sampler (default 30s) because process churn is
// noisier and would inflate the DB without adding signal.

const history = require('./history');
const logger  = require('./logger');
const { getProcesses } = require('./collectors/processes');

const SAMPLE_INTERVAL_MS = parseInt(process.env.OTHONI_PROC_SAMPLE_MS || '30000', 10);
const TOP_BY_CPU         = 20;
const TOP_BY_MEM_EXTRA   = 10; // additional memory-only rows beyond the CPU top-N
const MIN_SAMPLE_PCT     = 0.1; // skip rows where both cpu% and mem% are essentially zero

const RANGES = {
  '15m': 15 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '6h':  6  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

let sampleTimer = null;

async function takeSample() {
  const t = Date.now();
  // Single ps spawn — fetch enough rows to cover both top-CPU and top-mem
  // cuts, then sort in JS for the memory ranking. One spawn vs two saves
  // a child-process fork + exec on every 30s tick.
  const res = await getProcesses({ limit: TOP_BY_CPU + TOP_BY_MEM_EXTRA, sortBy: 'cpu' });
  const all = (res && res.processes) || [];

  // Top by memory from the same snapshot (re-sort in place on a copy).
  const byMemory = all.slice().sort((a, b) => b.memory - a.memory);

  const byPid = new Map();
  function addRow(p) {
    if (!p || !Number.isFinite(p.cpu) || !Number.isFinite(p.memory)) return;
    if (!p.name) return;
    if (p.cpu < MIN_SAMPLE_PCT && p.memory < MIN_SAMPLE_PCT) return;
    const prev = byPid.get(p.pid);
    if (!prev || p.cpu > prev.cpu) byPid.set(p.pid, p);
  }
  for (const p of all) addRow(p);
  for (const p of byMemory.slice(0, TOP_BY_MEM_EXTRA)) addRow(p);
  if (!byPid.size) return 0;

  const db = history.getDb();
  const stmt = db.prepare(
    'INSERT INTO process_samples (t, name, pid, cpu, mem) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction((rows) => {
    for (const r of rows) stmt.run(t, r.name, r.pid, r.cpu, r.memory);
  });
  tx([...byPid.values()]);
  return byPid.size;
}

function start() {
  // Defer the first sample so the metrics sampler gets the cold-start spotlight.
  setTimeout(() => takeSample().catch((e) => logger.warn('proc sample failed:', e.message)), 4000);
  sampleTimer = setInterval(
    () => takeSample().catch((e) => logger.warn('proc sample failed:', e.message)),
    SAMPLE_INTERVAL_MS
  );
  logger.info(
    `process-history: sampling every ${SAMPLE_INTERVAL_MS}ms ` +
    `(top ${TOP_BY_CPU} by cpu + ${TOP_BY_MEM_EXTRA} by mem)`
  );
}

function stop() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
}

// Aggregate query: which named processes have been heaviest in the given
// range? Groups by `name` (not PID) so a service that respawned still shows
// as one row. Returns a per-name sparkline of the chosen metric.
//
// Sort order is by **peak** (max) with average as a tie-breaker — "who
// spiked" is the question this view answers most directly. Sample count
// lets the UI show how often a name actually appeared in the top-N, so a
// process that hit 100% once is visually distinguishable from one that
// sustained 50% across the whole range.
function query({ range = '1h', limit = 10, sortBy = 'cpu', sparkPoints = 60 } = {}) {
  const span  = RANGES[range] || RANGES['1h'];
  const now   = Date.now();
  const from  = now - span;
  const isCpu = sortBy !== 'memory';
  const db    = history.getDb();

  const totalSamples = (db
    .prepare('SELECT COUNT(DISTINCT t) AS n FROM process_samples WHERE t >= ?')
    .get(from) || {}).n || 0;

  const rankSql = isCpu
    ? `SELECT name,
              MAX(cpu) AS peak, AVG(cpu) AS avg,
              MAX(mem) AS memPeak, AVG(mem) AS memAvg,
              COUNT(*) AS samples
         FROM process_samples
        WHERE t >= ?
        GROUP BY name
        ORDER BY peak DESC, avg DESC
        LIMIT ?`
    : `SELECT name,
              MAX(mem) AS peak, AVG(mem) AS avg,
              MAX(cpu) AS cpuPeak, AVG(cpu) AS cpuAvg,
              COUNT(*) AS samples
         FROM process_samples
        WHERE t >= ?
        GROUP BY name
        ORDER BY peak DESC, avg DESC
        LIMIT ?`;
  const top = db.prepare(rankSql).all(from, Math.max(1, Math.min(50, limit)));

  // Bucket-average the chosen metric for the sparkline. Same shape as the
  // main /api/history response so the existing <Sparkline> can render it.
  const bucket = Math.max(1000, Math.floor(span / Math.max(8, sparkPoints)));
  const sparkSql = `
      SELECT (t / ?) * ? AS t, ${isCpu ? 'MAX(cpu)' : 'MAX(mem)'} AS v
        FROM process_samples
       WHERE name = ? AND t >= ?
       GROUP BY (t / ?)
       ORDER BY t ASC`;
  const sparkStmt = db.prepare(sparkSql);

  const results = top.map((row) => {
    const points = sparkStmt.all(bucket, bucket, row.name, from, bucket).map((p) => ({
      t: p.t,
      v: Math.round(p.v * 100) / 100,
    }));
    if (isCpu) {
      return {
        name:    row.name,
        cpuPeak: Math.round((row.peak    || 0) * 100) / 100,
        cpuAvg:  Math.round((row.avg     || 0) * 100) / 100,
        memPeak: Math.round((row.memPeak || 0) * 100) / 100,
        memAvg:  Math.round((row.memAvg  || 0) * 100) / 100,
        samples: row.samples,
        points,
      };
    }
    return {
      name:    row.name,
      cpuPeak: Math.round((row.cpuPeak || 0) * 100) / 100,
      cpuAvg:  Math.round((row.cpuAvg  || 0) * 100) / 100,
      memPeak: Math.round((row.peak    || 0) * 100) / 100,
      memAvg:  Math.round((row.avg     || 0) * 100) / 100,
      samples: row.samples,
      points,
    };
  });

  return {
    range,
    sortBy:  isCpu ? 'cpu' : 'memory',
    sampleMs: SAMPLE_INTERVAL_MS,
    totalSamples,
    bucketMs: bucket,
    from,
    to: now,
    top: results,
  };
}

module.exports = { start, stop, query };
