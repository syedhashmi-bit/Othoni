'use strict';

// Double-submit-cookie CSRF protection for cookie-authenticated routes.
//
// At login time, `auth.js` sets a non-httpOnly cookie `othoni_csrf` with a
// random token. The browser-side `api.js` wrapper reads it and echoes it
// back in the `X-Othoni-CSRF` header on every state-changing request.
// This middleware compares the two constant-time. Attackers running on
// another origin cannot read the cookie (same-origin policy) so cannot
// forge a matching header — that's the whole gate.
//
// Mounted AFTER cookie auth + role check on the /api router only. The
// metrics ingest (`POST /api/metrics`) uses Bearer auth and never carries
// the session cookie, so it's outside this middleware's reach. The sign-in,
// setup and logout endpoints (mounted before the cookie wall) are likewise
// not gated — they're entry points, and logout has nothing useful to attack.

const crypto = require('crypto');
const logger = require('./logger');

const COOKIE_NAME = 'othoni_csrf';
const HEADER_NAME = 'x-othoni-csrf';

// Defaults ON. Set OTHONI_CSRF_ENABLED=false to disable (the env-flag
// guidance in the roadmap was to allow rolling back without a deploy if
// some embedded usage breaks).
function isEnabled() {
  const v = (process.env.OTHONI_CSRF_ENABLED || 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Attach the token cookie on a successful login. Caller in auth.js
// already sets the session cookie; this is a sibling cookie with the
// same TTL but httpOnly:false so client JS can read it.
function attachCookie(res, token, { ttlMs, secure }) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: !!secure,
    maxAge: ttlMs,
    path: '/',
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Secure flag for the session + CSRF cookies. When OTHONI_PUBLIC_URL says
// the dashboard is https, always set it — req.secure can't be trusted
// behind a proxy that doesn't forward X-Forwarded-Proto, and that would
// ship the session cookie over plaintext. Otherwise follow the request, so
// a plain-http install (opened by IP on a LAN, or on localhost) can still
// keep its session.
function cookieSecure(req) {
  if (/^https:\/\//i.test((process.env.OTHONI_PUBLIC_URL || '').trim())) return true;
  return !!(req && req.secure);
}

// Backfill helper for `auth()` middleware: if a cookie session exists
// but the CSRF cookie is missing (pre-v0.39 cookies that survived the
// upgrade), mint one and attach it. Doesn't overwrite a valid cookie.
function ensureCookie(req, res, ttlMs) {
  if (!isEnabled()) return;
  if (req.cookies && req.cookies[COOKIE_NAME]) return;
  attachCookie(res, generateToken(), { ttlMs, secure: cookieSecure(req) });
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function middleware(req, res, next) {
  if (!isEnabled()) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const cookieToken = req.cookies && req.cookies[COOKIE_NAME];
  const headerToken = req.headers[HEADER_NAME];
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    logger.warn(`csrf: missing/mismatched token on ${req.method} ${req.path} from ${req.ip}`);
    return res.status(403).json({ error: 'csrf_required', message: 'CSRF token missing or invalid' });
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  HEADER_NAME,
  isEnabled,
  generateToken,
  attachCookie,
  clearCookie,
  cookieSecure,
  ensureCookie,
  middleware,
};
