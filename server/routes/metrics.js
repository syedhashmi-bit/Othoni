'use strict';

// POST /api/metrics — ingestion endpoint for externally-pushed `custom.*`
// metrics. Mounted BEFORE the cookie-auth wall so it can be hit with a
// bare API key (Authorization: Bearer othoni_<hex>) instead of a session.

const express = require('express');
const logger = require('../logger');
const history = require('../history');
const { apiKeyAuth, metricsLimiter } = require('../middleware');

const router = express.Router();

// Multi-host source attribution: an optional `host` field (per-metric, or
// top-level applying to all rows in the batch) gets validated as a
// DNS-friendly identifier and prepended onto the metric name. So an agent
// on "app-server-1" pushing `{ name: "custom.requests", host: "app-server-1" }`
// lands as `custom.app-server-1.requests` in the store. Existing agents
// that don't send `host` continue to write the un-prefixed name — fully
// backwards compatible.
const HOST_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

function isValidHost(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 40 && HOST_PATTERN.test(s);
}

function applyHost(row, defaultHost) {
  const host = isValidHost(row.host) ? row.host : (isValidHost(defaultHost) ? defaultHost : null);
  if (!host) return row;
  if (typeof row.name !== 'string' || !row.name.startsWith('custom.')) return row;
  // Splice the host between `custom.` and the rest of the name.
  const tail = row.name.slice('custom.'.length);
  return { ...row, name: `custom.${host}.${tail}` };
}

// Both shapes accepted:
//   { name, value, t?, host? }                              (single)
//   { metrics: [ { name, value, t?, host? }, ... ], host? } (batch; top-level
//                                                             host is the default
//                                                             for rows that omit it)
function normalize(body) {
  if (body && Array.isArray(body.metrics)) return body.metrics;
  if (body && typeof body.name === 'string') return [body];
  return null;
}

router.post('/', apiKeyAuth, metricsLimiter, express.json({ limit: '256kb' }), (req, res) => {
  const rows = normalize(req.body);
  if (!rows || rows.length === 0) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'expected { name, value, t? } or { metrics: [{...}, ...] }',
    });
  }
  if (rows.length > 1000) {
    return res.status(413).json({
      error: 'batch_too_large',
      message: `max 1000 metrics per request (got ${rows.length})`,
    });
  }

  const defaultHost = req.body && req.body.host;
  // Reject explicitly-bad host values up front with a clear error rather than
  // silently dropping the prefix and storing the un-attributed metric.
  if (defaultHost != null && !isValidHost(defaultHost)) {
    return res.status(400).json({
      error: 'invalid_host',
      message: 'host must match [a-z0-9-]{1,40} (DNS-style label)',
    });
  }
  for (const r of rows) {
    if (r && r.host != null && !isValidHost(r.host)) {
      return res.status(400).json({
        error: 'invalid_host',
        message: `metric "${r.name}" has invalid host (must match [a-z0-9-]{1,40})`,
      });
    }
  }

  const finalRows = rows.map((r) => applyHost(r, defaultHost));

  try {
    const n = history.insertCustomBatch(finalRows);
    res.json({ ok: true, accepted: n, by: req.apiKey.label });
  } catch (e) {
    if (e.code === 'invalid_metric' || e.code === 'invalid_value') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    logger.error('metrics ingest failed:', e.message);
    res.status(500).json({ error: 'ingest_failed' });
  }
});

module.exports = router;
