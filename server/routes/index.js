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
const history = require('../history');

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
