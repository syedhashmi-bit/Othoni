'use strict';

// Per-delivery history for webhooks. Recording happens inline in
// `webhooks.fireOne` (one row per HTTP attempt — first try AND retry).
// Stored in the shared SQLite store and pruned at the existing 24h
// retention sweep alongside samples / process_samples / alert_fires /
// audit_log.
//
// Why per-attempt rather than per-event: the retry-on-failure path
// is exactly where the operator wants visibility. Collapsing two
// attempts into one row hides whether the first attempt 5xx'd and
// the retry succeeded, which is the interesting case for tuning.

const history = require('./history');
const logger = require('./logger');

const RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

let schemaReady = false;
let insertStmt = null;

function ensureSchema() {
  if (schemaReady) return;
  history.getDb().exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      t           INTEGER NOT NULL,
      webhook_id  TEXT    NOT NULL,
      ok          INTEGER NOT NULL,
      status_code INTEGER,
      error       TEXT,
      duration_ms INTEGER,
      attempt     INTEGER,
      event_label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_t    ON webhook_deliveries(t);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_id_t ON webhook_deliveries(webhook_id, t);
  `);
  schemaReady = true;
}

function getInsertStmt() {
  if (!insertStmt) {
    ensureSchema();
    insertStmt = history.getDb().prepare(
      `INSERT INTO webhook_deliveries
         (t, webhook_id, ok, status_code, error, duration_ms, attempt, event_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }
  return insertStmt;
}

function record({
  webhookId,
  ok,
  statusCode = null,
  error = null,
  durationMs = null,
  attempt = 0,
  eventLabel = null,
} = {}) {
  if (!webhookId) return;
  try {
    getInsertStmt().run(
      Date.now(),
      webhookId,
      ok ? 1 : 0,
      statusCode,
      error,
      durationMs,
      attempt,
      eventLabel
    );
  } catch (e) {
    logger.warn(`webhook-history: insert failed: ${e.message}`);
  }
}

function query(webhookId, { range = '24h', limit = 50 } = {}) {
  ensureSchema();
  const span = RANGES[range] || RANGES['24h'];
  const from = Date.now() - span;
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const db = history.getDb();

  const rows = db
    .prepare(
      `SELECT t, ok, status_code, error, duration_ms, attempt, event_label
       FROM webhook_deliveries
       WHERE webhook_id = ? AND t >= ?
       ORDER BY t DESC
       LIMIT ?`
    )
    .all(webhookId, from, lim);

  const agg = db
    .prepare(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS okN,
          SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failN,
          AVG(duration_ms)                       AS avgDuration
       FROM webhook_deliveries
       WHERE webhook_id = ? AND t >= ?`
    )
    .get(webhookId, from);

  return {
    range,
    webhookId,
    stats: {
      total: agg.total || 0,
      ok: agg.okN || 0,
      fail: agg.failN || 0,
      avgDurationMs: agg.avgDuration ? Math.round(agg.avgDuration) : null,
    },
    deliveries: rows.map((r) => ({
      t: r.t,
      ok: !!r.ok,
      statusCode: r.status_code,
      error: r.error,
      durationMs: r.duration_ms,
      attempt: r.attempt,
      eventLabel: r.event_label,
    })),
  };
}

// Last-N attempts per webhook, ordered oldest → newest (UI reads
// left-to-right). Used inline by listWebhooks() so the dot strip per row
// is one query, not N.
function queryStrip(webhookId, n = 12) {
  ensureSchema();
  const lim = Math.min(50, Math.max(1, parseInt(n, 10) || 12));
  const rows = history
    .getDb()
    .prepare(
      `SELECT ok, t FROM webhook_deliveries
       WHERE webhook_id = ?
       ORDER BY t DESC
       LIMIT ?`
    )
    .all(webhookId, lim);
  // Reverse so oldest is first — strip reads left-to-right oldest→newest.
  return rows.reverse().map((r) => ({ t: r.t, ok: !!r.ok }));
}

module.exports = { record, query, queryStrip, ensureSchema };
