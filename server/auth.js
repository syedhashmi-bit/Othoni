'use strict';

const jwt = require('jsonwebtoken');
const logger = require('./logger');
const audit = require('./audit');
const sessions = require('./sessions');
const csrf = require('./csrf');
const google = require('./google-auth');

const COOKIE_NAME = 'othoni_session';
// Holds the OAuth `state` between /api/auth/google and its callback; scoped
// to that path so it never rides along on normal API traffic.
const FLOW_COOKIE = 'othoni_oauth';
const FLOW_COOKIE_PATH = '/api/auth/google';

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

const DEFAULT_JWT_SECRETS = new Set([
  'change-me-please-use-a-long-random-string',
  'othoni-dev-insecure-secret',
]);

function getSecret() {
  const s = process.env.OTHONI_JWT_SECRET;
  return s && !DEFAULT_JWT_SECRETS.has(s) ? s : 'othoni-dev-insecure-secret';
}

// Production must not boot on a placeholder JWT secret (anyone could forge
// a session for any role) or on a half-filled Google config. Outside
// production we allow the insecure default so `npm start` works with zero
// config. Fail closed: collect every problem and throw so the operator sees
// all of them at once. Called once at startup from index.js, before listen().
function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = [];
  const jwt = process.env.OTHONI_JWT_SECRET;
  if (!jwt || DEFAULT_JWT_SECRETS.has(jwt)) {
    problems.push('OTHONI_JWT_SECRET is unset or a known default — set a long random string');
  } else if (jwt.length < 32) {
    problems.push('OTHONI_JWT_SECRET is too short — use at least 32 random characters');
  }
  problems.push(...google.configProblems());
  if (problems.length) {
    const err = new Error(
      'Refusing to start in production with insecure auth config:\n  - ' +
        problems.join('\n  - ')
    );
    err.code = 'insecure_prod_config';
    throw err;
  }
}

// Startup notes about sign-in that shouldn't stop the boot: no Google
// client means nobody can log in (fine for a federation peer, surprising
// anywhere else), and leftover password-era settings now do nothing.
const RETIRED_AUTH_VARS = [
  'OTHONI_ADMIN_USER', 'OTHONI_ADMIN_PASSWORD', 'OTHONI_ADMIN_PASSWORD_HASH',
  'OTHONI_VIEWER_USER', 'OTHONI_VIEWER_PASSWORD', 'OTHONI_VIEWER_PASSWORD_HASH',
  'OTHONI_TOTP_SECRET', 'OTHONI_LOGIN_LOCKOUT_FAILS', 'OTHONI_LOGIN_LOCKOUT_MS',
];
function logAuthConfig() {
  if (!google.isConfigured()) {
    logger.warn(
      'Google sign-in is not configured — nobody can log in to the dashboard. ' +
        'Set OTHONI_GOOGLE_CLIENT_ID, OTHONI_GOOGLE_CLIENT_SECRET, OTHONI_PUBLIC_URL and OTHONI_ADMIN_EMAILS.'
    );
  }
  const leftover = RETIRED_AUTH_VARS.filter((k) => process.env[k]);
  if (leftover.length) {
    logger.info(`sign-in is Google-only; these .env settings are ignored and can be removed: ${leftover.join(', ')}`);
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
  // .env is the source of truth for who's allowed: re-resolve the role on
  // every request so removing (or demoting) an email and restarting takes
  // effect immediately rather than when the cookie expires. This also
  // retires every session minted by the old password login.
  const role = google.roleFor(decoded.sub);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  sessions.touch(decoded.sid);
  // Backfill the CSRF cookie for sessions that pre-date v0.39 so the next
  // state-changing request from the same browser will find a cookie to
  // echo. No-op when the cookie already exists.
  csrf.ensureCookie(req, res, sessionTtlMs());
  req.user = { username: decoded.sub, role, sid: decoded.sid };
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

// Seat a session for an identity that has already been verified: sessions
// row, JWT cookie carrying its sid, and the sibling CSRF cookie.
function startSession(req, res, { username, role, metadata }) {
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
    metadata: { ...metadata, role, sid },
  });
}

// GET /api/auth/google — first leg of Google sign-in. Pins a fresh `state`
// to this browser and bounces it to Google's account chooser.
function googleStart(req, res) {
  if (!google.isConfigured()) return res.redirect(302, '/login?error=not_configured');
  const { state, url } = google.beginFlow(google.redirectUri(req));
  res.cookie(FLOW_COOKIE, state, {
    httpOnly: true,
    // Lax still sends the cookie on Google's top-level GET redirect back.
    sameSite: 'lax',
    secure: cookieSecure(req),
    maxAge: google.FLOW_TTL_MS,
    path: FLOW_COOKIE_PATH,
  });
  res.redirect(302, url);
}

// Reasons the login page knows how to explain. Anything else is "failed".
const PUBLIC_FAILURES = new Set(['denied', 'expired', 'unverified', 'not_allowed']);

// GET /api/auth/google/callback — Google sends the browser back here with
// ?code&state (or ?error). Every outcome ends in a redirect: `/` with a
// session on success, `/login?error=<reason>` otherwise.
async function googleCallback(req, res) {
  const q = req.query || {};
  const cookieState = (req.cookies && req.cookies[FLOW_COOKIE]) || '';
  res.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });

  const fail = (reason, detail, email) => {
    logger.warn(`google sign-in failed (${reason}) from ${req.ip}${detail ? `: ${detail}` : ''}`);
    audit.log({
      actor: email || null,
      action: 'login.fail',
      ip: req.ip || null,
      metadata: { method: 'google', reason },
    });
    const shown = PUBLIC_FAILURES.has(reason) ? reason : 'failed';
    res.redirect(302, `/login?error=${shown}`);
  };

  // The user backed out on Google's side (access_denied) or Google refused.
  if (typeof q.error === 'string') return fail('denied', q.error);
  const state = typeof q.state === 'string' ? q.state : '';
  // State must match the cookie this browser got in googleStart — that's
  // what stops someone from completing *their* login in *your* browser.
  if (!state || !constantTimeEqual(state, cookieState)) return fail('expired', 'state mismatch');
  const flow = google.takeFlow(state);
  if (!flow) return fail('expired', 'unknown or expired state');
  if (typeof q.code !== 'string' || !q.code) return fail('failed', 'missing code');

  try {
    const identity = await google.completeFlow(q.code, flow);
    startSession(req, res, {
      username: identity.email,
      role: identity.role,
      metadata: { method: 'google', sub: identity.sub },
    });
    res.redirect(302, '/');
  } catch (e) {
    fail(e.code || 'failed', e.message, e.email);
  }
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

module.exports = { auth, requireAdmin, googleStart, googleCallback, logout, me, COOKIE_NAME, peerTokenEnabled, assertProductionSecrets, logAuthConfig };
