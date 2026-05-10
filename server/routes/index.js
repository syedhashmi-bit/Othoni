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
  res.json({ ok: true });
});

// ---------- alerts ----------

router.get('/alerts/rules', (req, res) => {
  res.json({ rules: alerts.getRules() });
});

router.put('/alerts/rules', (req, res) => {
  try {
    const next = alerts.setRules(req.body && req.body.rules);
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
      label:  req.body && req.body.label,
      url:    req.body && req.body.url,
      format: req.body && req.body.format,
    });
    res.json({ webhook: created });
  } catch (e) {
    if (e.code === 'invalid_label' || e.code === 'invalid_url') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    logger.error('webhooks create failed:', e.message);
    res.status(500).json({ error: 'webhooks_failed' });
  }
});

router.patch('/webhooks/:id', (req, res) => {
  const updated = webhooks.updateWebhook(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json({ webhook: updated });
});

router.delete('/webhooks/:id', (req, res) => {
  const ok = webhooks.revokeWebhook(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/webhooks/:id/test', async (req, res) => {
  const result = await webhooks.testWebhook(req.params.id);
  if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  res.json(result);
});

// ---------- synthetic checks ----------

router.get('/checks', (req, res) => {
  res.json({ checks: checks.listChecks() });
});

router.post('/checks', (req, res) => {
  try {
    const c = checks.createCheck(req.body || {});
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
  res.json({ check: updated });
});

router.delete('/checks/:id', (req, res) => {
  const ok = checks.removeCheck(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.post('/checks/:id/run', async (req, res) => {
  const c = await checks.runNow(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json({ check: c });
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
