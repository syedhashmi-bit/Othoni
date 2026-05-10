'use strict';

const jwt = require('jsonwebtoken');
const logger = require('./logger');
const { verifyTotp } = require('./totp');

const COOKIE_NAME = 'othoni_session';

// True iff a TOTP secret is configured. The login page reads this via
// /api/health to decide whether to render the code field.
function totpEnabled() {
  return !!(process.env.OTHONI_TOTP_SECRET && process.env.OTHONI_TOTP_SECRET.trim());
}

function getSecret() {
  const s = process.env.OTHONI_JWT_SECRET;
  if (!s || s === 'change-me-please-use-a-long-random-string') {
    if (process.env.NODE_ENV === 'production') {
      logger.warn(
        'OTHONI_JWT_SECRET is unset or default. Set a strong secret in .env.'
      );
    }
  }
  return s || 'othoni-dev-insecure-secret';
}

function sign(payload) {
  return jwt.sign(payload, getSecret(), {
    expiresIn: process.env.OTHONI_SESSION_TTL || '12h',
  });
}

function verify(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch {
    return null;
  }
}

function readToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function auth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const decoded = verify(token);
  if (!decoded) return res.status(401).json({ error: 'unauthorized' });
  req.user = { username: decoded.sub };
  next();
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function login(req, res) {
  const { username, password, totp } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_request' });
  }
  const expectedUser = process.env.OTHONI_ADMIN_USER || 'admin';
  const expectedPass = process.env.OTHONI_ADMIN_PASSWORD || 'admin123';
  // Always run all comparisons regardless of which (if any) failed — keeps
  // timing constant and avoids leaking whether the password or the TOTP was
  // wrong. The client always sees a single "invalid_credentials".
  const passOk =
    constantTimeEqual(username, expectedUser) &&
    constantTimeEqual(password, expectedPass);
  let totpOk = true;
  if (totpEnabled()) {
    totpOk = typeof totp === 'string' && verifyTotp(process.env.OTHONI_TOTP_SECRET, totp);
  }
  if (!passOk || !totpOk) {
    logger.warn(`failed login for "${username}" from ${req.ip}`);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = sign({ sub: username });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ ok: true, user: { username } });
}

function logout(_req, res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ user: req.user });
}

module.exports = { auth, login, logout, me, COOKIE_NAME, totpEnabled };
