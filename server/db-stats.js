'use strict';

// Storage stats for the in-process SQLite store. Surfaces enough detail
// for an operator to answer "how big is my history, what's eating the
// space, and is retention working?" without reaching for sqlite3 on the
// box. Read-only — no VACUUM / DELETE here (vacuum on a busy WAL DB
// takes an exclusive lock; we'd rather not race the sampler).

const fs = require('fs');
const path = require('path');
const history = require('./history');

const DB_PATH = process.env.OTHONI_DB || path.join(__dirname, '..', 'data', 'othoni.db');
const SAMPLE_INTERVAL_MS = parseInt(process.env.OTHONI_SAMPLE_MS || '5000', 10);
const PROC_SAMPLE_INTERVAL_MS = parseInt(process.env.OTHONI_PROC_SAMPLE_MS || '30000', 10);
const RETENTION_MS = parseInt(process.env.OTHONI_RETENTION_MS || String(24 * 60 * 60 * 1000), 10);

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

function tableStats(db, table) {
  const r = db
    .prepare(`SELECT COUNT(*) AS n, MIN(t) AS oldest, MAX(t) AS newest FROM ${table}`)
    .get();
  return {
    count: r.n || 0,
    oldestAt: r.oldest || null,
    newestAt: r.newest || null,
  };
}

function getDbStats({ topN = 20 } = {}) {
  const db = history.getDb();

  const samples = tableStats(db, 'samples');
  const processSamples = tableStats(db, 'process_samples');
  const alertFires = tableStats(db, 'alert_fires');

  const top = db
    .prepare(
      `SELECT metric, COUNT(*) AS n, MIN(t) AS oldest, MAX(t) AS newest
       FROM samples
       GROUP BY metric
       ORDER BY n DESC
       LIMIT ?`
    )
    .all(topN);

  const distinctMetrics =
    db.prepare('SELECT COUNT(DISTINCT metric) AS n FROM samples').get().n || 0;

  // The WAL + shm files are part of the on-disk footprint while the DB
  // is open; surface them separately so the headline number doesn't
  // confuse operators when WAL is checkpointed back into the main file.
  const sizes = {
    main: fileSize(DB_PATH),
    wal: fileSize(`${DB_PATH}-wal`),
    shm: fileSize(`${DB_PATH}-shm`),
  };
  const sizeBytes = (sizes.main || 0) + (sizes.wal || 0) + (sizes.shm || 0);

  return {
    path: DB_PATH,
    sizeBytes,
    sizeBreakdown: sizes,
    config: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      processSampleIntervalMs: PROC_SAMPLE_INTERVAL_MS,
      retentionMs: RETENTION_MS,
    },
    tables: {
      samples,
      process_samples: processSamples,
      alert_fires: alertFires,
    },
    distinctMetrics,
    byMetricTop: top.map((r) => ({
      metric: r.metric,
      count: r.n,
      oldestAt: r.oldest,
      newestAt: r.newest,
    })),
  };
}

module.exports = { getDbStats };
