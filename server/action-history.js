'use strict';

// Per-action durable log alongside the audit_log entry. The audit_log
// captures who/what/when with a 200-byte stdout/stderr snippet — fine
// for general audit browsing. action_history persists the FULL (up to
// 8 KB per stream) output so the dedicated /actions page can show
// what a restart actually printed without needing to re-run.
//
// Stored in the shared SQLite store, pruned at the existing 24h
// retention sweep alongside samples / process_samples / alert_fires /
// audit_log / webhook_deliveries.

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
    CREATE TABLE IF NOT EXISTS action_history (
      t           INTEGER NOT NULL,
      actor       TEXT,
      kind        TEXT    NOT NULL,
      target      TEXT,
      ip          TEXT,
      ok          INTEGER NOT NULL,
      exit_code   INTEGER,
      duration_ms INTEGER,
      dry_run     INTEGER NOT NULL DEFAULT 0,
      stdout      TEXT,
      stderr      TEXT,
      params      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_history_t      ON action_history(t);
    CREATE INDEX IF NOT EXISTS idx_action_history_kind_t ON action_history(kind, t);
    CREATE INDEX IF NOT EXISTS idx_action_history_actor_t ON action_history(actor, t);
  `);
  schemaReady = true;
}

function getInsertStmt() {
  if (!insertStmt) {
    ensureSchema();
    insertStmt = history.getDb().prepare(
      `INSERT INTO action_history
         (t, actor, kind, target, ip, ok, exit_code, duration_ms, dry_run, stdout, stderr, params)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }
  return insertStmt;
}

function record({
  actor = null,
  kind,
  target = null,
  ip = null,
  ok,
  exitCode = null,
  durationMs = null,
  dryRun = false,
  stdout = '',
  stderr = '',
  params = null,
} = {}) {
  if (!kind) return;
  try {
    getInsertStmt().run(
      Date.now(),
      actor,
      kind,
      target,
      ip,
      ok ? 1 : 0,
      exitCode,
      durationMs,
      dryRun ? 1 : 0,
      stdout || '',
      stderr || '',
      params != null ? JSON.stringify(params) : null
    );
  } catch (e) {
    logger.warn(`action-history: insert failed: ${e.message}`);
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function query({
  range = '24h',
  kind = null,
  actor = null,
  outcome = null,   // 'ok' | 'fail' | null (any)
  limit = 100,
} = {}) {
  ensureSchema();
  const span = RANGES[range] || RANGES['24h'];
  const from = Date.now() - span;
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const db = history.getDb();

  const where = ['t >= ?'];
  const params = [from];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (actor) { where.push('actor = ?'); params.push(actor); }
  if (outcome === 'ok') where.push('ok = 1');
  else if (outcome === 'fail') where.push('ok = 0');

  const sql = `SELECT t, actor, kind, target, ip, ok, exit_code AS exitCode,
                      duration_ms AS durationMs, dry_run AS dryRun, stdout,
                      stderr, params
               FROM action_history
               WHERE ${where.join(' AND ')}
               ORDER BY t DESC
               LIMIT ?`;
  params.push(lim);
  const rows = db.prepare(sql).all(...params);

  // Aggregate counts per kind / per outcome in the range so the UI can
  // render a breakdown without a second round-trip.
  const counts = db
    .prepare(
      `SELECT kind, COUNT(*) AS n,
              SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS okN,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failN,
              AVG(duration_ms) AS avgDurationMs
       FROM action_history
       WHERE t >= ?
       GROUP BY kind
       ORDER BY n DESC`
    )
    .all(from);

  return {
    range,
    from,
    to: Date.now(),
    counts,
    events: rows.map((r) => ({
      ...r,
      ok: !!r.ok,
      dryRun: !!r.dryRun,
      params: r.params ? safeJson(r.params) : null,
    })),
  };
}

// Distinct actors that have run an action in the requested range. Used
// for the actor filter dropdown.
function listActors({ range = '24h' } = {}) {
  ensureSchema();
  const span = RANGES[range] || RANGES['24h'];
  const from = Date.now() - span;
  const rows = history
    .getDb()
    .prepare(
      `SELECT DISTINCT actor FROM action_history
       WHERE t >= ? AND actor IS NOT NULL
       ORDER BY actor ASC`
    )
    .all(from);
  return rows.map((r) => r.actor);
}

module.exports = { record, query, listActors, ensureSchema };
