'use strict';

const express = require('express');
const logger = require('../logger');

const { getSystem } = require('../collectors/system');
const { getCpu } = require('../collectors/cpu');
const { getMemory } = require('../collectors/memory');
const { getDisks } = require('../collectors/disks');
const { getNetwork } = require('../collectors/network');
const { getProcesses } = require('../collectors/processes');
const { getDocker } = require('../collectors/docker');
const { getServices } = require('../collectors/services');
const { getDiskIO } = require('../collectors/diskio');
const { getConnections } = require('../collectors/connections');
const { getLogs, isEnabled: isLogsEnabled } = require('../collectors/logs');
const apiKeys = require('../api-keys');
const alerts = require('../alerts');
const webhooks = require('../webhooks');
const checks = require('../checks');
const history = require('../history');
const processHistory = require('../process-history');
const dbStats = require('../db-stats');
const audit = require('../audit');
const webhookHistory = require('../webhook-history');
const hosts = require('../hosts');
const actions = require('../actions');
const actionHistory = require('../action-history');
const sessions = require('../sessions');
const hostMeta = require('../host-meta');

const router = express.Router();

const wrap = (label, fn) => async (req, res) => {
  try {
    const data = await fn(req);
    res.json(data);
  } catch (e) {
    logger.error(`${label} failed:`, e && e.message ? e.message : e);
    res.status(500).json({ error: `${label}_failed`, message: 'Unable to read data right now.' });
  }
};

router.get('/system', wrap('system', () => getSystem()));
router.get('/cpu', wrap('cpu', () => getCpu()));
router.get('/memory', wrap('memory', () => getMemory()));
router.get('/disks', wrap('disks', () => getDisks()));
router.get('/network', wrap('network', () => getNetwork()));
router.get('/diskio', wrap('diskio', () => getDiskIO()));
router.get('/connections', wrap('connections', () => getConnections()));

// Logs are gated behind OTHONI_LOGS_ENABLED — they can leak sensitive data
// (passwords in error messages, tokens, IPs, command lines) and shouldn't be
// available by default. When disabled we still respond 200 so the UI can
// render the "enable me" hint cleanly.
router.get('/logs', async (req, res) => {
  if (!isLogsEnabled()) {
    return res.json({
      enabled: false,
      reason: 'OTHONI_LOGS_ENABLED is not set',
      entries: [],
    });
  }
  try {
    const data = await getLogs({
      limit: req.query.limit,
      priority: req.query.priority,
      unit: req.query.unit,
      since: req.query.since,
      until: req.query.until,
    });
    res.json(data);
  } catch (e) {
    logger.error('logs failed:', e && e.message ? e.message : e);
    res.status(500).json({ error: 'logs_failed', message: 'Unable to read logs.' });
  }
});
router.get(
  '/processes',
  wrap('processes', (req) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
    const sortBy = req.query.sortBy === 'memory' ? 'memory' : 'cpu';
    return getProcesses({ limit, sortBy });
  })
);
router.get('/docker', wrap('docker', () => getDocker()));
router.get('/services', wrap('services', () => getServices()));

router.get(
  '/history',
  wrap('history', (req) => {
    const metric = String(req.query.metric || 'cpu');
    const range = String(req.query.range || '1h');
    const maxPoints = Math.min(parseInt(req.query.maxPoints || '500', 10) || 500, 2000);
    return history.query({ metric, range, maxPoints });
  })
);

// Distinct metric names currently stored. The History page calls this
// (with prefix=custom.) to auto-discover externally-pushed series.
router.get(
  '/history/metrics',
  wrap('history_metrics', (req) => {
    const prefix = req.query.prefix ? String(req.query.prefix) : undefined;
    return { metrics: history.listMetrics({ prefix }) };
  })
);

// On-disk SQLite store stats. Footprint on disk, retention/cadence
// config, per-table row counts + oldest/newest, plus the top-N metric
// names by row count. Powers the Storage card on Settings.
router.get('/db/stats', wrap('db_stats', () => dbStats.getDbStats()));

// Process trends. Returns the heaviest named processes in the requested
// range, each with a small sparkline of the chosen metric. Used by the
// Trends section of the Processes page.
router.get(
  '/history/processes',
  wrap('history_processes', (req) => {
    const range = String(req.query.range || '1h');
    const sortBy = req.query.sortBy === 'memory' ? 'memory' : 'cpu';
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10) || 10));
    return processHistory.query({ range, sortBy, limit });
  })
);

// API key management — all admin-auth (cookie session). Returns hashes-as-
// fingerprints only; the plaintext key is shown once at generation time.
router.get('/keys', (req, res) => {
  res.json({ keys: apiKeys.listKeys() });
});

router.post('/keys', (req, res) => {
  const label = req.body && req.body.label;
  if (typeof label !== 'string' || label.trim().length === 0) {
    return res.status(400).json({ error: 'invalid_label', message: 'label is required' });
  }
  try {
    const created = apiKeys.generateKey(label.trim());
    audit.log({
      ...audit.fromReq(req),
      action: 'apikey.create',
      target: created.id,
      metadata: { label: created.label, fingerprint: created.fingerprint },
    });
    res.json({ key: created });
  } catch (e) {
    if (e.code === 'invalid_label') {
      return res.status(400).json({ error: 'invalid_label', message: e.message });
    }
    logger.error('keys generate failed:', e.message);
    res.status(500).json({ error: 'keys_failed' });
  }
});

router.delete('/keys/:id', (req, res) => {
  const ok = apiKeys.revokeKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'apikey.revoke',
    target: req.params.id,
  });
  res.json({ ok: true });
});

// ---------- alerts ----------

router.get('/alerts/rules', (req, res) => {
  res.json({ rules: alerts.getRules() });
});

router.put('/alerts/rules', (req, res) => {
  try {
    const next = alerts.setRules(req.body && req.body.rules);
    audit.log({
      ...audit.fromReq(req),
      action: 'rules.update',
      metadata: { count: next.length },
    });
    res.json({ rules: next });
  } catch (e) {
    if (e.code === 'invalid_request') {
      return res.status(400).json({ error: 'invalid_request', message: e.message });
    }
    logger.error('alerts setRules failed:', e.message);
    res.status(500).json({ error: 'alerts_failed' });
  }
});

router.get('/alerts/active', (req, res) => {
  res.json({ active: alerts.getActive() });
});

router.get('/alerts/metrics', (req, res) => {
  res.json({ metrics: alerts.listMetrics() });
});

// Per-rule stats over a range (default 24h) with a small density histogram
// per rule. Used by the Alerts page to render "Fires (24h)" + a sparkline
// on each rule row without needing one request per rule.
router.get('/alerts/stats', (req, res) => {
  const range = String(req.query.range || '24h');
  res.json(alerts.getStats({ range }));
});

// Recent-fires timeline. Returns denormalized rows so deleted rules still
// render correctly.
router.get('/alerts/history', (req, res) => {
  const range = String(req.query.range || '24h');
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
  res.json(alerts.listFires({ range, limit }));
});

// ---------- webhooks ----------

router.get('/webhooks', (req, res) => {
  res.json({ webhooks: webhooks.listWebhooks() });
});

router.post('/webhooks', (req, res) => {
  try {
    const created = webhooks.createWebhook({
      label:      req.body && req.body.label,
      url:        req.body && req.body.url,
      format:     req.body && req.body.format,
      hostFilter: req.body && req.body.hostFilter,
    });
    audit.log({
      ...audit.fromReq(req),
      action: 'webhook.create',
      target: created.id,
      metadata: { label: created.label, format: created.format, hostFilter: created.hostFilter },
    });
    res.json({ webhook: created });
  } catch (e) {
    if (e.code === 'invalid_label' || e.code === 'invalid_url' || e.code === 'invalid_host_filter') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    logger.error('webhooks create failed:', e.message);
    res.status(500).json({ error: 'webhooks_failed' });
  }
});

router.patch('/webhooks/:id', (req, res) => {
  let updated;
  try {
    updated = webhooks.updateWebhook(req.params.id, req.body || {});
  } catch (e) {
    if (e.code === 'invalid_host_filter') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    throw e;
  }
  if (!updated) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'webhook.update',
    target: req.params.id,
    metadata: Object.keys(req.body || {}),
  });
  res.json({ webhook: updated });
});

router.delete('/webhooks/:id', (req, res) => {
  const ok = webhooks.revokeWebhook(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'webhook.delete',
    target: req.params.id,
  });
  res.json({ ok: true });
});

// Per-webhook delivery history. Each retry is its own row, on purpose —
// "first attempt 503'd, retry 200'd" is the interesting case for tuning.
router.get('/webhooks/:id/deliveries', (req, res) => {
  const range = String(req.query.range || '24h');
  const limit = parseInt(req.query.limit || '50', 10) || 50;
  res.json(webhookHistory.query(req.params.id, { range, limit }));
});

router.post('/webhooks/:id/test', async (req, res) => {
  const result = await webhooks.testWebhook(req.params.id);
  if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'webhook.test',
    target: req.params.id,
    metadata: { ok: !!result.ok, status: result.status || null },
  });
  res.json(result);
});

// ---------- synthetic checks ----------

router.get('/checks', (req, res) => {
  res.json({ checks: checks.listChecks() });
});

router.post('/checks', (req, res) => {
  try {
    const c = checks.createCheck(req.body || {});
    audit.log({
      ...audit.fromReq(req),
      action: 'check.create',
      target: c.id,
      metadata: { label: c.label, type: c.type, target: c.target },
    });
    res.json({ check: c });
  } catch (e) {
    if (['invalid_label', 'invalid_type', 'invalid_target'].includes(e.code)) {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    logger.error('checks create failed:', e.message);
    res.status(500).json({ error: 'checks_failed' });
  }
});

router.patch('/checks/:id', (req, res) => {
  const updated = checks.updateCheck(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'check.update',
    target: req.params.id,
    metadata: Object.keys(req.body || {}),
  });
  res.json({ check: updated });
});

router.delete('/checks/:id', (req, res) => {
  const ok = checks.removeCheck(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'check.delete',
    target: req.params.id,
  });
  res.json({ ok: true });
});

router.post('/checks/:id/run', async (req, res) => {
  const c = await checks.runNow(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'check.run',
    target: req.params.id,
    metadata: { up: c.lastResult?.up ?? null },
  });
  res.json({ check: c });
});

// Per-host snapshot. Auto-discovers hosts from `custom.<host>.*` metric
// names (laid down by v0.23.0 host attribution + v0.25.0 agent.sh) and
// returns the latest value of each known agent metric per host. The
// response also overlays any per-host metadata stored via /api/host-meta
// (v0.43).
router.get('/hosts', wrap('hosts', () => ({ hosts: hosts.getHosts() })));

// Per-host detail (v0.44). 404 when the host has neither live samples
// in the last 10 minutes, nor stored metadata, nor any alert_fires
// rows — i.e. nothing this dashboard knows about by that name.
router.get('/hosts/:host', (req, res) => {
  const detail = hosts.getHostDetail(req.params.host);
  if (!detail) return res.status(404).json({ error: 'not_found' });
  res.json({ host: detail });
});

// ---------- host metadata (v0.43) ----------
// Operator-supplied overlay (owner, environment, tags, notes) keyed by
// host. Independent of the metric ingest — metadata stays put even if
// the agent goes silent for a while, and a fresh host that hasn't been
// labeled yet just has `meta: null` on the /hosts response.

router.get('/host-meta', (req, res) => {
  res.json({ byHost: hostMeta.all() });
});

router.put('/host-meta/:host', (req, res) => {
  try {
    const next = hostMeta.upsert(req.params.host, req.body || {});
    audit.log({
      ...audit.fromReq(req),
      action: 'host.meta.update',
      target: req.params.host,
      metadata: Object.keys(req.body || {}),
    });
    res.json({ host: req.params.host, meta: next });
  } catch (e) {
    if (e.code === 'invalid_host' || e.code === 'invalid_request') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    logger.error('host-meta upsert failed:', e.message);
    res.status(500).json({ error: 'host_meta_failed' });
  }
});

router.delete('/host-meta/:host', (req, res) => {
  const ok = hostMeta.remove(req.params.host);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'host.meta.delete',
    target: req.params.host,
  });
  res.json({ ok: true });
});

// ---------- actions ----------
// Off by default. When disabled, GET returns 200 with enabled:false so
// the UI can render the "enable me" hint (mirrors /api/logs pattern);
// POST returns 404.

router.get('/actions', (req, res) => {
  if (!actions.isEnabled()) {
    return res.json({
      enabled: false,
      reason: 'OTHONI_ACTIONS_ENABLED is not set',
      kinds: [],
    });
  }
  res.json({ enabled: true, kinds: actions.listKindsWithDetail() });
});

// Per-action durable history. Pulls from the action_history table
// (richer than the audit_log snippet view; full stdout/stderr up to
// the 8 KB cap from the framework). Returned even when actions are
// disabled — old rows may still be of interest.
router.get('/actions/history', (req, res) => {
  const range = String(req.query.range || '24h');
  const kind = req.query.kind ? String(req.query.kind) : null;
  const actor = req.query.actor ? String(req.query.actor) : null;
  const outcome = req.query.outcome ? String(req.query.outcome) : null;
  const limit = parseInt(req.query.limit || '100', 10) || 100;
  res.json(actionHistory.query({ range, kind, actor, outcome, limit }));
});

router.get('/actions/history/actors', (req, res) => {
  const range = String(req.query.range || '24h');
  res.json({ actors: actionHistory.listActors({ range }) });
});

router.post('/actions/run', async (req, res) => {
  if (!actions.isEnabled()) {
    return res.status(404).json({ error: 'not_found' });
  }
  const body = req.body || {};
  if (typeof body.kind !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: 'kind is required' });
  }
  try {
    const result = await actions.runAction({
      kind: body.kind,
      target: body.target,
      params: body.params || {},
      actor: req.user && req.user.username,
      ip: req.ip || null,
      dryRun: !!body.dryRun,
    });
    res.json({ result });
  } catch (e) {
    if (e.code === 'unknown_kind' || e.code === 'invalid_target' || e.code === 'invalid_params') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    if (e.code === 'busy') {
      return res.status(409).json({ error: 'busy', message: e.message });
    }
    if (e.code === 'actions_disabled') {
      return res.status(404).json({ error: 'not_found' });
    }
    logger.error('actions run failed:', e.message);
    res.status(500).json({ error: 'action_failed', message: e.message });
  }
});

// Combined snapshot for the dashboard so the UI can refresh in one round-trip.
router.get(
  '/overview',
  wrap('overview', async () => {
    const [system, cpu, memory, disks, network, diskio] = await Promise.all([
      getSystem(),
      getCpu(),
      getMemory(),
      getDisks(),
      getNetwork(),
      getDiskIO(),
    ]);
    return { system, cpu, memory, disks, network, diskio };
  })
);

// ---------- audit log ----------

// Recent admin-action audit events. Sorted newest first, capped at `limit`
// (default 200, max 1000). Optional `action=` filter for drill-down.
router.get('/audit', (req, res) => {
  const range = String(req.query.range || '24h');
  const action = req.query.action ? String(req.query.action) : null;
  const limit = parseInt(req.query.limit || '200', 10) || 200;
  res.json(audit.query({ range, action, limit }));
});

// List of valid action names for the filter dropdown.
router.get('/audit/actions', (req, res) => {
  res.json({ actions: audit.listActions() });
});

// ---------- sessions (v0.38) ----------
// Admin sees every session; viewer sees only their own (so they can confirm
// where they're logged in without exposing the admin's session list).
// Revoke is admin-only — blocked at the router-level requireAdmin guard.

router.get('/sessions', (req, res) => {
  const all = sessions.listAll();
  const visible = req.user.role === 'admin'
    ? all
    : all.filter((s) => s.actor === req.user.username);
  res.json({
    sessions: visible.map((s) => ({
      sid: s.sid,
      actor: s.actor,
      role: s.role,
      ip: s.ip,
      ua: s.ua,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      revokedBy: s.revokedBy,
      self: s.sid === req.user.sid,
    })),
  });
});

router.delete('/sessions/:sid', (req, res) => {
  const ok = sessions.revoke(req.params.sid, { revokedBy: req.user.username });
  if (!ok) return res.status(404).json({ error: 'not_found' });
  audit.log({
    ...audit.fromReq(req),
    action: 'session.revoke',
    target: req.params.sid,
    metadata: { self: req.params.sid === req.user.sid },
  });
  res.json({ ok: true });
});

// Settings (server-side bits the UI may want to display)
router.get('/settings', (req, res) => {
  res.json({
    port: parseInt(process.env.PORT || '8088', 10),
    host: process.env.HOST || '0.0.0.0',
    user: req.user || null,
    hostname: require('os').hostname(),
    version: require('../../package.json').version,
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});

module.exports = router;
