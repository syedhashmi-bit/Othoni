'use strict';

// Audit log of admin actions — logins, API key gen/revoke, alert-rule
// edits, webhook + check edits, manual check runs. Stored in the same
// SQLite file as everything else (one connection, one WAL session).
// Pruned at the same 24h retention sweep as samples / process_samples
// / alert_fires.
//
// Audit *never* throws into the caller — a broken insert should not
// break the action being audited. We log and move on.

const history = require('./history');
const logger = require('./logger');

// Whitelist of action names. Strict so a typo upstream surfaces as a
// warning rather than silently writing nonsense.
const VALID_ACTIONS = new Set([
  'login.ok',
  'login.fail',
  'login.lockout',
  'logout',
  'apikey.create',
  'apikey.revoke',
  'rules.update',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'webhook.test',
  'check.create',
  'check.update',
  'check.delete',
  'check.run',
  // Phase 1 action endpoints. Pre-reserved here so audit doesn't
  // warn about unknown action names when v0.32–v0.34 wire them in.
  'action.noop',
  'action.systemd.restart',
  'action.docker.start',
  'action.docker.stop',
  'action.docker.restart',
  'action.process.signal',
  // Phase 2 session management (v0.38).
  'session.revoke',
]);

let insertStmt = null;
let schemaReady = false;

function ensureSchema() {
  if (schemaReady) return;
  const db = history.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      t        INTEGER NOT NULL,
      actor    TEXT,
      action   TEXT    NOT NULL,
      target   TEXT,
      ip       TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_t        ON audit_log(t);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_t ON audit_log(action, t);
  `);
  schemaReady = true;
}

function getInsertStmt() {
  if (!insertStmt) {
    ensureSchema();
    insertStmt = history
      .getDb()
      .prepare(
        'INSERT INTO audit_log (t, actor, action, target, ip, metadata) VALUES (?, ?, ?, ?, ?, ?)'
      );
  }
  return insertStmt;
}

function log({ actor = null, action, target = null, ip = null, metadata = null } = {}) {
  if (!action || !VALID_ACTIONS.has(action)) {
    logger.warn(`audit: unknown action "${action}" — not recorded`);
    return;
  }
  try {
    getInsertStmt().run(
      Date.now(),
      actor || null,
      action,
      target || null,
      ip || null,
      metadata != null ? JSON.stringify(metadata) : null
    );
  } catch (e) {
    logger.warn(`audit: insert failed: ${e.message}`);
  }
}

// Convenience: pull actor + ip out of an Express request. Falls back to
// `extras` if the request doesn't carry them (e.g. failed login before
// the user is attached).
function fromReq(req, extras = {}) {
  return {
    actor: (req && req.user && req.user.username) || extras.actor || null,
    ip: (req && req.ip) || extras.ip || null,
  };
}

const RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function query({ range = '24h', action = null, limit = 200 } = {}) {
  ensureSchema();
  const db = history.getDb();
  const span = RANGES[range] || RANGES['24h'];
  const from = Date.now() - span;
  const lim = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));

  let rows;
  if (action) {
    rows = db
      .prepare(
        `SELECT t, actor, action, target, ip, metadata
         FROM audit_log
         WHERE t >= ? AND action = ?
         ORDER BY t DESC
         LIMIT ?`
      )
      .all(from, action, lim);
  } else {
    rows = db
      .prepare(
        `SELECT t, actor, action, target, ip, metadata
         FROM audit_log
         WHERE t >= ?
         ORDER BY t DESC
         LIMIT ?`
      )
      .all(from, lim);
  }

  // Per-action counts in the range so the UI can show a breakdown without
  // a second round-trip.
  const counts = db
    .prepare(
      `SELECT action, COUNT(*) AS n
       FROM audit_log
       WHERE t >= ?
       GROUP BY action
       ORDER BY n DESC`
    )
    .all(from);

  return {
    range,
    from,
    to: Date.now(),
    counts,
    events: rows.map((r) => ({
      t: r.t,
      actor: r.actor,
      action: r.action,
      target: r.target,
      ip: r.ip,
      metadata: r.metadata ? safeJson(r.metadata) : null,
    })),
  };
}

function listActions() {
  return Array.from(VALID_ACTIONS).sort();
}

module.exports = { log, fromReq, query, listActions, ensureSchema };
