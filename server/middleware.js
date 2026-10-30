'use strict';

const rateLimit = require('express-rate-limit');
const apiKeys = require('./api-keys');

// Google sign-in round trips (start + callback = 2 hits per login). Both
// are browser navigations, so send the user back to the login page with a
// readable reason instead of a bare JSON body.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.redirect(302, '/login?error=rate_limited'),
});

// Password sign-in and first-run setup: JSON POSTs from the login and setup
// pages. login-lockout does the per-IP / per-account locking; this caps the
// raw request rate on top of it.
const loginApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Wait a few minutes and try again.' },
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

module.exports = { loginLimiter, loginApiLimiter, apiKeyAuth, metricsLimiter };
