'use strict';

// Bulk archive export (v0.49). Streams a JSON-Lines dump of every
// historical table in a time range — useful for offsite backup or
// ingestion into a "real" TSDB (Prometheus remote-write, ClickHouse,
// etc.) without standing up a separate replication path.
//
// Off by default. Enable by setting `OTHONI_EXPORT_TOKEN` in `.env`;
// the endpoint then expects `Authorization: Bearer <token>` (constant-
// time compared, separate from the cookie session and the Prometheus
// token). 404 when unset, 401 on missing/wrong, 200 streaming when
// authorized.
//
// Format: one JSON object per line. First line is a header with the
// export's range, version, and per-table row counts. Subsequent lines
// each carry `{ table, ...row-fields }` so a streaming parser can
// dispatch on `table`. Trailing line is `{ "_final": true, rowCount,
// truncated }` so the consumer can confirm a complete dump.
//
// Cap: `OTHONI_EXPORT_MAX_ROWS` (default 1_000_000). Defensive — a
// typo'd range against a year of dense ingest could otherwise stream
// arbitrary GBs.

const crypto = require('crypto');
const history = require('./history');

const VERSION = require('../package.json').version;

function isEnabled() {
  return !!(process.env.OTHONI_EXPORT_TOKEN && process.env.OTHONI_EXPORT_TOKEN.trim());
}

function checkAuth(req) {
  if (!isEnabled()) return { status: 404 };
  const expected = process.env.OTHONI_EXPORT_TOKEN;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return { status: 401 };
  const got = header.slice(7);
  if (got.length !== expected.length) return { status: 401 };
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return { status: 401 };
  return null;
}

const MAX_ROWS_DEFAULT = 1_000_000;
function maxRows() {
  const v = parseInt(process.env.OTHONI_EXPORT_MAX_ROWS || String(MAX_ROWS_DEFAULT), 10);
  return Number.isFinite(v) && v > 0 ? v : MAX_ROWS_DEFAULT;
}

// Tables we export, in order. Each entry: SQL, columns to keep, table
// name in the output. The `t` column is the time field on every table
// we ship.
const TABLES = [
  {
    table: 'samples',
    sql: 'SELECT t, metric, v FROM samples WHERE t >= ? AND t < ? ORDER BY t ASC, metric ASC',
  },
  {
    table: 'process_samples',
    sql: 'SELECT t, name, pid, cpu, mem FROM process_samples WHERE t >= ? AND t < ? ORDER BY t ASC',
  },
  {
    table: 'alert_fires',
    sql: 'SELECT t, rule_id, metric, severity, label, value, threshold, sustained_ms, comparator, host FROM alert_fires WHERE t >= ? AND t < ? ORDER BY t ASC',
  },
  {
    table: 'audit_log',
    sql: 'SELECT t, actor, action, target, ip, metadata FROM audit_log WHERE t >= ? AND t < ? ORDER BY t ASC',
  },
  {
    table: 'webhook_deliveries',
    sql: 'SELECT t, webhook_id, ok, status_code, error, duration_ms, attempt, event_label FROM webhook_deliveries WHERE t >= ? AND t < ? ORDER BY t ASC',
  },
  {
    table: 'action_history',
    sql: 'SELECT t, kind, target, actor, ip, ok, exit_code, duration_ms, dry_run, stdout, stderr FROM action_history WHERE t >= ? AND t < ? ORDER BY t ASC',
  },
];

// Streams the export to the response. Pulls rows one table at a time
// via better-sqlite3's `.iterate()` so we never materialize the full
// result set in JS heap. Each row is JSON-stringified + a newline; the
// response is `application/x-ndjson` so a curl pipeline can `jq` it
// directly.
function handleRequest(req, res) {
  const auth = checkAuth(req);
  if (auth) {
    res.status(auth.status).json(
      auth.status === 404
        ? { error: 'not_found' }
        : { error: 'unauthorized' }
    );
    return;
  }

  const now = Date.now();
  const fromRaw = req.query.from;
  const toRaw = req.query.to;
  // Defaults: last 24h. Clip `to` at the current time so a typo doesn't
  // ask for the future (cheap, but easier to reason about).
  const from = Number.isFinite(parseInt(fromRaw, 10)) ? parseInt(fromRaw, 10) : now - 24 * 60 * 60 * 1000;
  const to   = Number.isFinite(parseInt(toRaw, 10)) ? Math.min(parseInt(toRaw, 10), now) : now;
  if (to <= from) {
    res.status(400).json({ error: 'invalid_range', message: '`to` must be > `from`' });
    return;
  }

  const cap = maxRows();
  const tablesParam = (req.query.tables || '').toString().trim();
  const allowed = tablesParam ? new Set(tablesParam.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Othoni-Version', VERSION);
  // Pre-flight count so the header can carry per-table totals. Cheap;
  // SQLite uses the (metric, t) / (t) indexes.
  const db = history.getDb();
  const totals = {};
  let grandTotal = 0;
  for (const t of TABLES) {
    if (allowed && !allowed.has(t.table)) continue;
    const countSql = `SELECT COUNT(*) AS n FROM ${t.table} WHERE t >= ? AND t < ?`;
    let n = 0;
    try { n = db.prepare(countSql).get(from, to).n; }
    catch (_e) { n = 0; }
    totals[t.table] = n;
    grandTotal += n;
  }

  const truncated = grandTotal > cap;
  res.write(JSON.stringify({
    _header: true,
    version: VERSION,
    from, to,
    totals,
    grandTotal,
    cap,
    truncated,
  }) + '\n');

  let emitted = 0;
  for (const t of TABLES) {
    if (allowed && !allowed.has(t.table)) continue;
    if (emitted >= cap) break;
    const stmt = db.prepare(t.sql);
    for (const row of stmt.iterate(from, to)) {
      if (emitted >= cap) break;
      // Lightweight transform: surface the table name without
      // mutating the row object structure beyond the prefix.
      res.write(JSON.stringify({ table: t.table, ...row }) + '\n');
      emitted += 1;
    }
  }

  res.write(JSON.stringify({ _final: true, rowCount: emitted, truncated }) + '\n');
  res.end();
}

module.exports = { handleRequest, isEnabled };
