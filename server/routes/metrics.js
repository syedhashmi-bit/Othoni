'use strict';

// POST /api/metrics — ingestion endpoint for externally-pushed `custom.*`
// metrics. Mounted BEFORE the cookie-auth wall so it can be hit with a
// bare API key (Authorization: Bearer othoni_<hex>) instead of a session.

const express = require('express');
const logger = require('../logger');
const history = require('../history');
const { apiKeyAuth, metricsLimiter } = require('../middleware');

const router = express.Router();

// Both shapes accepted:
//   { name, value, t? }                              (single)
//   { metrics: [ { name, value, t? }, ... ] }        (batch)
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
  try {
    const n = history.insertCustomBatch(rows);
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
