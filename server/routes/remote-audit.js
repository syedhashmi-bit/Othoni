'use strict';

// POST /api/security-audit/ingest — accepts a security-audit run pushed by
// a remote agent (the bundled agent.sh with OTHONI_AUDIT=1). Bearer-token
// (API key) auth, NOT cookie auth — mounted before the `/api` cookie wall
// in index.js, the same pattern as POST /api/metrics. The dashboard's own
// read endpoints (/api/security-audit/hosts*) stay behind the cookie wall;
// this router only claims the `/ingest` sub-path and falls through for the
// rest.

const express = require('express');
const logger = require('../logger');
const securityAudit = require('../security-audit');
const { apiKeyAuth, metricsLimiter } = require('../middleware');

const router = express.Router();

// Body: { host, findings: [{ id, severity, category, title, detail?, evidence? }, ...], durationMs? }
router.post('/ingest', apiKeyAuth, metricsLimiter, express.json({ limit: '256kb' }), (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.findings)) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'expected { host, findings: [{ id, severity, category, title }, ...] }',
    });
  }
  try {
    const result = securityAudit.recordRemoteRun(body.host, body.findings, {
      durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
      source: req.apiKey.label,
    });
    res.json({ ok: true, host: result.host, accepted: result.summary.total, summary: result.summary });
  } catch (e) {
    if (e.code === 'invalid_host' || e.code === 'invalid_request') {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    logger.error('remote-audit ingest failed:', e.message);
    res.status(500).json({ error: 'ingest_failed' });
  }
});

module.exports = router;
