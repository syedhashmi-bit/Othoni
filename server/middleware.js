'use strict';

const rateLimit = require('express-rate-limit');
const apiKeys = require('./api-keys');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Reads `Authorization: Bearer othoni_<hex>`, looks up the key, attaches
// `req.apiKey = { id, label }` and updates last-used. Rejects 401 if the
// header is missing / malformed / unknown.
function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_api_key' });
  }
  const token = header.slice(7).trim();
  const key = apiKeys.lookup(token);
  if (!key) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  apiKeys.touch(key.id);
  req.apiKey = { id: key.id, label: key.label };
  next();
}

// Per-key rate limit on /api/metrics so a misbehaving agent can't DOS the
// SQLite writer. Keyed by req.apiKey.id (set by apiKeyAuth above) — falls
// back to client IP if the auth middleware hasn't run yet.
const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600, // 10/sec sustained per key
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKey?.id || req.ip,
  message: { error: 'rate_limited' },
});

module.exports = { loginLimiter, apiKeyAuth, metricsLimiter };
