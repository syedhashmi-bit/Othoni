'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('./logger');
const audit = require('./audit');
const sessions = require('./sessions');
const csrf = require('./csrf');
const google = require('./google-auth');
const accounts = require('./accounts');
const setup = require('./setup');
const lockout = require('./login-lockout');

const COOKIE_NAME = 'othoni_session';
// Holds the OAuth `state` between /api/auth/google and its callback; scoped
// to that path so it never rides along on normal API traffic.
const FLOW_COOKIE = 'othoni_oauth';
const FLOW_COOKIE_PATH = '/api/auth/google';
// Lockout key for wrong setup codes: one shared bucket, so guessing the
// code from many IPs still trips the lock.
const SETUP_LOCK_KEY = '(setup)';

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

// Session-signing secret. OTHONI_JWT_SECRET wins when it's set to something
// real; otherwise a random one is generated once and kept in
// data/session-secret (0600), so a fresh install or a container needs no
// secret in its config and sessions survive restarts.
const SECRET_PATH = process.env.OTHONI_SECRET_PATH || path.join(__dirname, '..', 'data', 'session-secret');
let fileSecret = null;

function getSecret() {
  const s = process.env.OTHONI_JWT_SECRET;
  if (s && !DEFAULT_JWT_SECRETS.has(s)) return s;
  if (!fileSecret) fileSecret = loadOrCreateFileSecret();
  return fileSecret;
}

function loadOrCreateFileSecret() {
  try {
    const v = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (v.length >= 32) return v;
  } catch { /* first run — create it below */ }
  const v = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, v + '\n', { mode: 0o600 });
  logger.info(`generated a session-signing secret in ${SECRET_PATH}`);
  return v;
}

// Production must not boot on a known placeholder or too-short JWT secret
// (anyone could forge a session for any role) or on a half-filled Google
// config. Unset is fine — getSecret() generates one. Fail closed: collect
// every problem and throw so the operator sees all of them at once. Called
// once at startup from index.js, before listen().
function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = [];
  const jwtSecret = process.env.OTHONI_JWT_SECRET;
  if (jwtSecret && DEFAULT_JWT_SECRETS.has(jwtSecret)) {
    problems.push('OTHONI_JWT_SECRET is a known default — remove it (othoni generates one) or set a long random string');
  } else if (jwtSecret && jwtSecret.length < 32) {
    problems.push('OTHONI_JWT_SECRET is too short — use at least 32 random characters, or remove it to have one generated');
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

// Startup notes about sign-in that shouldn't stop the boot. Also creates the
// session secret up front, so an unwritable data/ dir fails at boot rather
// than on the first login.
const RETIRED_AUTH_VARS = [
  'OTHONI_ADMIN_USER', 'OTHONI_ADMIN_PASSWORD', 'OTHONI_ADMIN_PASSWORD_HASH',
  'OTHONI_VIEWER_USER', 'OTHONI_VIEWER_PASSWORD', 'OTHONI_VIEWER_PASSWORD_HASH',
  'OTHONI_TOTP_SECRET',
];
function logAuthConfig() {
  getSecret();
  if (!accounts.passwordLoginEnabled() && !google.isConfigured()) {
    logger.warn(
      'Password sign-in is off and Google sign-in is not configured — nobody can log in to the dashboard. ' +
        'Remove OTHONI_PASSWORD_LOGIN=off, or set OTHONI_GOOGLE_CLIENT_ID, OTHONI_GOOGLE_CLIENT_SECRET, OTHONI_PUBLIC_URL and OTHONI_ADMIN_EMAILS.'
    );
  }
  const leftover = RETIRED_AUTH_VARS.filter((k) => process.env[k]);
  if (leftover.length) {
    logger.info(`these .env settings from older versions are ignored and can be removed (accounts live in Settings → Access now): ${leftover.join(', ')}`);
  }
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

// Who a session's email is right now, by how it signed in: the accounts
// file for password sessions (and only while password sign-in is on), the
// .env allowlist for Google ones. Tokens from before v0.79 carry no method
// and were all Google.
function currentRole(method, email) {
  if (method === 'password') return accounts.passwordLoginEnabled() ? accounts.roleFor(email) : null;
  return google.roleFor(email);
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
  // Re-resolve the role on every request, so deleting, disabling or
  // demoting an account (or editing the Google allowlist and restarting)
  // takes effect immediately rather than when the cookie expires.
  const method = decoded.m === 'password' ? 'password' : 'google';
  const role = currentRole(method, decoded.sub);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  sessions.touch(decoded.sid);
  // Backfill the CSRF cookie for sessions that pre-date v0.39 so the next
  // state-changing request from the same browser will find a cookie to
  // echo. No-op when the cookie already exists.
  csrf.ensureCookie(req, res, sessionTtlMs());
  req.user = { username: decoded.sub, role, sid: decoded.sid, method };
  next();
}

// Refuse non-GET / non-HEAD when the session role is viewer. Mounted on the
// /api router below the cookie wall, so the only state-changing routes it
// doesn't cover are the ones mounted before it in index.js (sign-in, setup,
// logout, and changing your own password).
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
// row, JWT cookie carrying its sid and sign-in method, and the sibling CSRF
// cookie.
function startSession(req, res, { username, role, method, metadata }) {
  const ttl = sessionTtlMs();
  const sid = sessions.create({
    actor: username,
    role,
    ip: req.ip || null,
    ua: (req.headers['user-agent'] || '').slice(0, 256) || null,
    ttlMs: ttl,
  });
  const token = sign({ sub: username, role, sid, m: method });
  const secure = csrf.cookieSecure(req);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: ttl,
    path: '/',
  });
  // Sibling CSRF cookie (non-httpOnly so client JS can echo it back as a
  // header). The api.js wrapper reads it on every state-changing request.
  csrf.attachCookie(res, csrf.generateToken(), { ttlMs: ttl, secure });
  audit.log({
    actor: username,
    action: 'login.ok',
    ip: req.ip || null,
    metadata: { ...metadata, role, sid },
  });
  return sid;
}

function lockedResponse(res, lock) {
  const secs = lock.retryAfterSec || 900;
  res.set('Retry-After', String(secs));
  return res.status(429).json({
    error: 'locked',
    retryAfterSec: secs,
    message: `Too many failed attempts — try again in ${Math.ceil(secs / 60)} min.`,
  });
}

function auditActor(email) {
  return typeof email === 'string' && email ? email.trim().toLowerCase().slice(0, 128) : null;
}

// POST /api/auth/login — { email, password }.
function passwordLogin(req, res) {
  if (!accounts.passwordLoginEnabled()) {
    return res.status(404).json({ error: 'password_login_off', message: 'Password sign-in is turned off on this server.' });
  }
  const { email, password } = req.body || {};
  const lock = lockout.check(req.ip, email);
  if (lock.locked) return lockedResponse(res, lock);
  const who = accounts.verifyLogin(email, password);
  if (!who) {
    const after = lockout.recordFailure(req.ip, { actor: auditActor(email), username: email });
    audit.log({
      actor: auditActor(email),
      action: 'login.fail',
      ip: req.ip || null,
      metadata: { method: 'password', reason: 'bad_credentials' },
    });
    if (after.locked) return lockedResponse(res, after);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Wrong email or password.' });
  }
  lockout.recordSuccess(req.ip, email);
  startSession(req, res, {
    username: who.email,
    role: who.role,
    method: 'password',
    metadata: { method: 'password', account: who.id },
  });
  res.json({ user: { username: who.email, role: who.role, method: 'password' } });
}

// GET /api/setup — public: is this instance still waiting for its first
// admin? (Never reveals the code.)
function setupStatus(_req, res) {
  res.json({ needed: setup.needed() });
}

// POST /api/setup — { code, email, password }: creates the first admin and
// signs them in. Synchronous on purpose, so two racing requests can't both
// see "no accounts yet".
function setupComplete(req, res) {
  if (!setup.needed()) {
    return res.status(409).json({ error: 'already_set_up', message: 'This othoni already has an account — sign in instead.' });
  }
  const { code, email, password } = req.body || {};
  const lock = lockout.check(req.ip, SETUP_LOCK_KEY);
  if (lock.locked) return lockedResponse(res, lock);
  if (!setup.check(code)) {
    const after = lockout.recordFailure(req.ip, { username: SETUP_LOCK_KEY });
    audit.log({ actor: null, action: 'login.fail', ip: req.ip || null, metadata: { method: 'setup', reason: 'bad_code' } });
    if (after.locked) return lockedResponse(res, after);
    return res.status(403).json({
      error: 'bad_code',
      message: "That setup code isn't right. Use the link the installer printed, or the code in data/setup-code on the server.",
    });
  }
  let created;
  try {
    created = accounts.create({ email, password, role: 'admin', createdBy: 'setup' });
  } catch (e) {
    if (['invalid_email', 'invalid_password', 'email_taken'].includes(e.code)) {
      return res.status(400).json({ error: e.code, message: e.message });
    }
    throw e;
  }
  setup.discard();
  lockout.recordSuccess(req.ip, SETUP_LOCK_KEY);
  audit.log({ actor: created.email, action: 'setup.complete', ip: req.ip || null, metadata: { account: created.id } });
  startSession(req, res, {
    username: created.email,
    role: 'admin',
    method: 'password',
    metadata: { method: 'setup', account: created.id },
  });
  res.json({ user: { username: created.email, role: 'admin', method: 'password' } });
}

// POST /api/account/password — { current, password }: change your own
// password. Mounted behind auth + CSRF but not requireAdmin, so viewers can
// use it too. Signs out your other sessions.
function changeOwnPassword(req, res) {
  if (req.user.method !== 'password') {
    return res.status(400).json({ error: 'not_password_session', message: 'This session signed in with Google — there is no othoni password to change.' });
  }
  const email = req.user.username;
  const { current, password } = req.body || {};
  const lock = lockout.check(req.ip, email);
  if (lock.locked) return lockedResponse(res, lock);
  const who = accounts.verifyLogin(email, current, { stamp: false });
  if (!who) {
    const after = lockout.recordFailure(req.ip, { actor: email, username: email });
    if (after.locked) return lockedResponse(res, after);
    return res.status(403).json({ error: 'wrong_password', message: 'Your current password is wrong.' });
  }
  try {
    accounts.setPassword(who.id, password);
  } catch (e) {
    if (e.code === 'invalid_password') return res.status(400).json({ error: e.code, message: e.message });
    throw e;
  }
  lockout.recordSuccess(req.ip, email);
  const revoked = revokeSessionsOf(email, { except: req.user.sid, by: email });
  audit.log({
    ...audit.fromReq(req),
    action: 'user.update',
    target: who.id,
    metadata: { email, changed: ['password'], self: true, revokedSessions: revoked },
  });
  res.json({ ok: true, revokedSessions: revoked });
}

// Revoke every live session belonging to `email` (optionally keeping one).
function revokeSessionsOf(email, { except = null, by = 'system' } = {}) {
  let n = 0;
  for (const s of sessions.listAll()) {
    if (s.actor === email && s.revokedAt == null && s.sid !== except) {
      if (sessions.revoke(s.sid, { revokedBy: by })) n++;
    }
  }
  return n;
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
    secure: csrf.cookieSecure(req),
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
      method: 'google',
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

module.exports = {
  auth,
  requireAdmin,
  passwordLogin,
  setupStatus,
  setupComplete,
  changeOwnPassword,
  revokeSessionsOf,
  googleStart,
  googleCallback,
  logout,
  me,
  COOKIE_NAME,
  peerTokenEnabled,
  assertProductionSecrets,
  logAuthConfig,
};
