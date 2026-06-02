'use strict';

const jwt = require('jsonwebtoken');
const logger = require('./logger');
const audit = require('./audit');
const sessions = require('./sessions');
const csrf = require('./csrf');
const loginLockout = require('./login-lockout');
const { verifyTotp } = require('./totp');
const { verifyPassword, isHash } = require('./password-hash');
const users = require('./users');

const COOKIE_NAME = 'othoni_session';

// Same TTL used for both the JWT signature and the sessions row's
// `expiresAt`. Parses the same duration string jsonwebtoken accepts,
// fallback 12h.
function sessionTtlMs() {
  const raw = process.env.OTHONI_SESSION_TTL || '12h';
  const m = /^(\d+)\s*([smhd])?$/i.exec(String(raw).trim());
  if (!m) return 12 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'h').toLowerCase();
  return n * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] || 3_600_000);
}

// True iff a TOTP secret is configured. The login page reads this via
// /api/health to decide whether to render the code field.
function totpEnabled() {
  return !!(process.env.OTHONI_TOTP_SECRET && process.env.OTHONI_TOTP_SECRET.trim());
}

const DEFAULT_JWT_SECRETS = new Set([
  'change-me-please-use-a-long-random-string',
  'othoni-dev-insecure-secret',
]);
const DEFAULT_ADMIN_PASSWORD = 'admin123';

function getSecret() {
  const s = process.env.OTHONI_JWT_SECRET;
  return s && !DEFAULT_JWT_SECRETS.has(s) ? s : 'othoni-dev-insecure-secret';
}

// Production must not boot on placeholder credentials. Outside production we
// allow the insecure defaults so `npm start` works with zero config, but in
// production a forgotten secret means a predictable JWT signing key (forge
// any session/role) or a default admin password — both full-takeover bugs.
// Fail closed: collect every problem and throw so the operator sees all of
// them at once. Called once at startup from index.js, before listen().
function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = [];
  const jwt = process.env.OTHONI_JWT_SECRET;
  if (!jwt || DEFAULT_JWT_SECRETS.has(jwt)) {
    problems.push('OTHONI_JWT_SECRET is unset or a known default — set a long random string');
  } else if (jwt.length < 32) {
    problems.push('OTHONI_JWT_SECRET is too short — use at least 32 random characters');
  }
  // The env admin account is always active (defaults to admin/admin123), so
  // a strong admin credential must be provided unless a password HASH is set.
  const adminHash = process.env.OTHONI_ADMIN_PASSWORD_HASH;
  const adminPass = process.env.OTHONI_ADMIN_PASSWORD;
  const haveValidHash = adminHash && isHash(adminHash);
  if (!haveValidHash && (!adminPass || adminPass === DEFAULT_ADMIN_PASSWORD)) {
    problems.push(
      'OTHONI_ADMIN_PASSWORD is unset or the default "admin123" — set a strong password (or OTHONI_ADMIN_PASSWORD_HASH)'
    );
  }
  if (problems.length) {
    const err = new Error(
      'Refusing to start in production with insecure auth config:\n  - ' +
        problems.join('\n  - ')
    );
    err.code = 'insecure_prod_config';
    throw err;
  }
}

// Session/CSRF cookies must carry the Secure flag in production. Deriving it
// from req.secure is unreliable behind a TLS-terminating proxy that doesn't
// forward X-Forwarded-Proto, which would ship the session cookie without
// Secure and allow it to leak over plaintext. Force it on in production;
// fall back to req.secure elsewhere so plain-HTTP local dev still works.
function cookieSecure(req) {
  if (process.env.NODE_ENV === 'production') return true;
  return !!(req && req.secure);
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

// Federation read path. A central othoni proxies dashboard GETs to this
// instance with the shared OTHONI_PEER_TOKEN as a Bearer credential. We grant
// a synthetic *viewer* session: `requireAdmin` downstream enforces GET/HEAD
// only, so a peer can read everything a viewer can but can never mutate state.
// Off entirely unless OTHONI_PEER_TOKEN is set (and non-trivially long).
function peerTokenValid(req) {
  const expected = process.env.OTHONI_PEER_TOKEN;
  if (typeof expected !== 'string' || expected.trim().length < 16) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  return constantTimeEqual(header.slice(7).trim(), expected);
}

function auth(req, res, next) {
  if (peerTokenValid(req)) {
    req.user = { username: 'peer', role: 'viewer', sid: null, peer: true };
    return next();
  }
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const decoded = verify(token);
  if (!decoded) return res.status(401).json({ error: 'unauthorized' });
  // v0.38: every token carries a session id. Reject tokens without one
  // (pre-v0.38 leftovers) and tokens whose session has been revoked.
  if (!decoded.sid || !sessions.getActive(decoded.sid)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  sessions.touch(decoded.sid);
  // Backfill the CSRF cookie for sessions that pre-date v0.39 so the next
  // state-changing request from the same browser will find a cookie to
  // echo. No-op when the cookie already exists.
  csrf.ensureCookie(req, res, sessionTtlMs());
  req.user = {
    username: decoded.sub,
    role: decoded.role === 'viewer' ? 'viewer' : 'admin',
    sid: decoded.sid,
  };
  next();
}

// Refuse non-GET / non-HEAD when the session role is viewer. Mounted on the
// /api router below the cookie wall, so the only state-changing route it
// doesn't cover is /api/auth/* (logout is fine for viewers; login is
// pre-auth).
function requireAdmin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'forbidden', message: 'read-only session' });
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// True iff a viewer account is configured. Viewer creds are optional —
// no env vars = no viewer login path.
function viewerEnabled() {
  const u = process.env.OTHONI_VIEWER_USER;
  if (typeof u !== 'string' || u.trim().length === 0) return false;
  const h = process.env.OTHONI_VIEWER_PASSWORD_HASH;
  const p = process.env.OTHONI_VIEWER_PASSWORD;
  return !!((h && isHash(h)) || (typeof p === 'string' && p.length > 0));
}

// Check creds against a (user, hash-or-plaintext) pair. Always runs the
// hash path when a hash is provided to avoid a timing channel between
// hash-configured and plaintext-configured deployments.
function checkPasswordFor(plaintextPass, hash, plaintextExpected) {
  if (hash && isHash(hash)) return verifyPassword(plaintextPass, hash);
  if (typeof plaintextExpected === 'string') return constantTimeEqual(plaintextPass, plaintextExpected);
  return false;
}

function login(req, res) {
  const { username, password, totp } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_request' });
  }
  // v0.40 lockout: stop checking credentials entirely while the IP is
  // locked. Returns 429 with a Retry-After header so well-behaved
  // clients back off. Locked IPs don't consume scrypt CPU.
  const lock = loginLockout.check(req.ip, username);
  if (lock.locked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      message: `Too many failed attempts. Try again in ${lock.retryAfterSec}s.`,
      retryAfterSec: lock.retryAfterSec,
      unlockAt: lock.unlockAt,
    });
  }
  const expectedAdminUser = process.env.OTHONI_ADMIN_USER || 'admin';
  const adminHash = process.env.OTHONI_ADMIN_PASSWORD_HASH;
  const adminPass = process.env.OTHONI_ADMIN_PASSWORD || 'admin123';

  // Always run both username comparisons + both password checks so the
  // login timing doesn't reveal which account exists. The viewer slot
  // returns false on every check when it isn't configured.
  const adminUserMatch = constantTimeEqual(username, expectedAdminUser);
  const adminPassMatch = checkPasswordFor(password, adminHash, adminPass);

  const viewerUser = process.env.OTHONI_VIEWER_USER || ' nope ';
  const viewerHash = process.env.OTHONI_VIEWER_PASSWORD_HASH;
  const viewerPass = process.env.OTHONI_VIEWER_PASSWORD;
  const viewerEnabledNow = viewerEnabled();
  const viewerUserMatch = constantTimeEqual(username, viewerUser);
  const viewerPassMatch = viewerEnabledNow
    ? checkPasswordFor(password, viewerHash, viewerPass)
    : checkPasswordFor(password, null, ' nope ');

  let role = null;
  if (adminUserMatch && adminPassMatch) role = 'admin';
  else if (viewerEnabledNow && viewerUserMatch && viewerPassMatch) role = 'viewer';

  // v0.60 — stored multi-user. Checked AFTER the env-based slots so a
  // legacy deployment relying on env vars keeps the same behaviour.
  // Reserved-name guard at create time prevents a stored user from
  // shadowing either env account, so this can never silently downgrade
  // an admin login to viewer.
  if (!role) {
    const storedMatch = users.verifyLogin(username, password);
    if (storedMatch) role = storedMatch.role;
  }

  let totpOk = true;
  if (totpEnabled()) {
    totpOk = typeof totp === 'string' && verifyTotp(process.env.OTHONI_TOTP_SECRET, totp);
  }
  if (!role || !totpOk) {
    logger.warn(`failed login for "${username}" from ${req.ip}`);
    const result = loginLockout.recordFailure(req.ip, { actor: username, username });
    audit.log({
      actor: typeof username === 'string' ? username : null,
      action: 'login.fail',
      ip: req.ip || null,
      metadata: { totp: totpEnabled(), failsRemaining: result.failsRemaining },
    });
    if (result.locked) {
      res.set('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        error: 'locked_out',
        message: `Too many failed attempts. Try again in ${result.retryAfterSec}s.`,
        retryAfterSec: result.retryAfterSec,
        unlockAt: result.unlockAt,
      });
    }
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  // Successful login clears the lockout counters for this IP and username.
  loginLockout.recordSuccess(req.ip, username);
  const ttl = sessionTtlMs();
  const sid = sessions.create({
    actor: username,
    role,
    ip: req.ip || null,
    ua: (req.headers['user-agent'] || '').slice(0, 256) || null,
    ttlMs: ttl,
  });
  const token = sign({ sub: username, role, sid });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    maxAge: ttl,
    path: '/',
  });
  // Sibling CSRF cookie (non-httpOnly so client JS can echo it back as a
  // header). The api.js wrapper reads it on every state-changing request.
  const csrfToken = csrf.generateToken();
  csrf.attachCookie(res, csrfToken, { ttlMs: ttl, secure: cookieSecure(req) });
  audit.log({
    actor: username,
    action: 'login.ok',
    ip: req.ip || null,
    metadata: { totp: totpEnabled(), role, sid },
  });
  res.json({ ok: true, user: { username, role } });
}

function logout(req, res) {
  // Logout runs outside the `auth` middleware so req.user may be missing.
  // Decode the cookie defensively to capture the sid we should revoke.
  let sid = null;
  let actor = null;
  if (req.user) {
    sid = req.user.sid;
    actor = req.user.username;
  } else {
    const token = readToken(req);
    const decoded = token && verify(token);
    if (decoded) {
      sid = decoded.sid || null;
      actor = decoded.sub || null;
    }
  }
  if (sid) sessions.revoke(sid, { revokedBy: actor || 'self' });
  audit.log({
    actor,
    action: 'logout',
    ip: req.ip || null,
    metadata: sid ? { sid } : null,
  });
  res.clearCookie(COOKIE_NAME, { path: '/' });
  csrf.clearCookie(res);
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ user: req.user });
}

// True iff this instance accepts a federation peer token (i.e. it can be
// read by a central othoni). Surfaced via /api/settings for the UI.
function peerTokenEnabled() {
  const t = process.env.OTHONI_PEER_TOKEN;
  return typeof t === 'string' && t.trim().length >= 16;
}

module.exports = { auth, requireAdmin, login, logout, me, COOKIE_NAME, totpEnabled, viewerEnabled, peerTokenEnabled, assertProductionSecrets };
