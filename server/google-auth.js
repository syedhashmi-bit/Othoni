'use strict';

// Google sign-in — the only way into the dashboard. Standard OIDC
// authorization-code flow: /api/auth/google sends the browser to Google
// with a random `state` (bound to the browser by a short-lived cookie), a
// `nonce` (bound into the ID token) and a PKCE challenge; the callback
// swaps the code for an ID token server-to-server, verifies its RS256
// signature against Google's published keys, and maps the verified email
// to a role through the .env allowlist. No SDK: Node's fetch + crypto and
// the jsonwebtoken we already ship are enough.
//
// Who gets in is env-only, matching the rest of othoni's auth config:
//   OTHONI_ADMIN_EMAILS   comma-separated Google emails → admin
//   OTHONI_VIEWER_EMAILS  comma-separated Google emails → viewer (read-only)
// Any other account — even a valid, verified Google login — is rejected.
//
// In-flight logins live in an in-process Map (one othoni process per box),
// so a restart mid-login just means "click Sign in again".

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CALLBACK_PATH = '/api/auth/google/callback';

const FLOW_TTL_MS = 10 * 60 * 1000;
// Bound memory if someone hammers /api/auth/google. Oldest entries are
// evicted first; at worst that cancels a login that was mid-flight.
const MAX_PENDING = 500;
const FETCH_TIMEOUT_MS = 10_000;
// Re-fetch Google's keys on an unknown `kid` (key rotation), but no more
// than once a minute so a garbage token can't make us hammer the endpoint.
const JWKS_REFETCH_MIN_MS = 60_000;

function parseEmails(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function config() {
  return {
    clientId: (process.env.OTHONI_GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.OTHONI_GOOGLE_CLIENT_SECRET || '').trim(),
    publicUrl: (process.env.OTHONI_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    admins: parseEmails(process.env.OTHONI_ADMIN_EMAILS),
    viewers: parseEmails(process.env.OTHONI_VIEWER_EMAILS),
  };
}

// True iff sign-in can actually work: a client, its secret, and at least
// one allowed email. The login page reads this via /api/health.
function isConfigured() {
  const c = config();
  return !!(c.clientId && c.clientSecret && (c.admins.length || c.viewers.length));
}

// Startup problems for assertProductionSecrets. Nothing set at all is NOT
// a problem — a federation peer that nobody logs into directly shouldn't
// need a Google client — but a half-filled config is an operator mistake
// worth refusing to boot over.
function configProblems() {
  const c = config();
  const any = c.clientId || c.clientSecret || c.admins.length || c.viewers.length;
  if (!any) return [];
  const problems = [];
  if (!c.clientId) problems.push('OTHONI_GOOGLE_CLIENT_ID is unset');
  if (!c.clientSecret) problems.push('OTHONI_GOOGLE_CLIENT_SECRET is unset');
  if (!c.admins.length && !c.viewers.length) {
    problems.push('OTHONI_ADMIN_EMAILS (or OTHONI_VIEWER_EMAILS) is empty — nobody could sign in');
  }
  if (!/^https:\/\/[^/]+/.test(c.publicUrl)) {
    problems.push('OTHONI_PUBLIC_URL must be the https:// origin browsers use (e.g. https://othoni.example.com)');
  }
  return problems;
}

// 'admin' | 'viewer' | null for a (verified) email. Admin wins if an email
// is listed in both.
function roleFor(email) {
  if (typeof email !== 'string' || !email) return null;
  const c = config();
  const e = email.toLowerCase();
  if (c.admins.includes(e)) return 'admin';
  if (c.viewers.includes(e)) return 'viewer';
  return null;
}

// Must match an "Authorized redirect URI" on the Google client exactly.
// OTHONI_PUBLIC_URL is required in production (see configProblems); the
// request-derived fallback only exists so local dev works without it.
function redirectUri(req) {
  const c = config();
  if (c.publicUrl) return c.publicUrl + CALLBACK_PATH;
  return `${req.protocol}://${req.get('host')}${CALLBACK_PATH}`;
}

function fail(code, detail, extra) {
  return Object.assign(new Error(detail || code), { code }, extra || {});
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- in-flight logins ----------

const pending = new Map(); // state -> { nonce, verifier, redirectUri, expiresAt }

function prunePending(now) {
  for (const [state, f] of pending) {
    if (f.expiresAt <= now) pending.delete(state);
  }
  while (pending.size >= MAX_PENDING) {
    pending.delete(pending.keys().next().value);
  }
}

// Start a login: remember the per-attempt secrets and return the Google URL
// to send the browser to, plus the `state` the caller pins in a cookie.
function beginFlow(redirect) {
  const now = Date.now();
  prunePending(now);
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pending.set(state, { nonce, verifier, redirectUri: redirect, expiresAt: now + FLOW_TTL_MS });
  const params = new URLSearchParams({
    client_id: config().clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Always show the account chooser, so someone who picked the wrong
    // account (and got "not allowed") can pick another next time.
    prompt: 'select_account',
  });
  return { state, url: `${AUTH_URL}?${params}` };
}

// One-shot: a state can only ever be redeemed once.
function takeFlow(state) {
  const f = pending.get(state);
  pending.delete(state);
  if (!f || f.expiresAt <= Date.now()) return null;
  return f;
}

// ---------- Google's signing keys ----------

let jwks = { keys: new Map(), fetchedAt: 0, expiresAt: 0 };

async function refreshJwks() {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw fail('failed', `JWKS fetch returned ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of (body && body.keys) || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); }
    catch { /* skip a malformed key rather than failing every login */ }
  }
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const now = Date.now();
  jwks = {
    keys,
    fetchedAt: now,
    expiresAt: now + (maxAge ? parseInt(maxAge[1], 10) * 1000 : 60 * 60 * 1000),
  };
}

async function signingKey(kid) {
  const now = Date.now();
  const expired = now >= jwks.expiresAt;
  if (expired || (!jwks.keys.has(kid) && now - jwks.fetchedAt >= JWKS_REFETCH_MIN_MS)) {
    await refreshJwks();
  }
  return jwks.keys.get(kid) || null;
}

// ---------- the callback half ----------

async function exchangeCode(code, flow) {
  const c = config();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: flow.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: flow.verifier,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || !body || typeof body.id_token !== 'string') {
    const why = body && body.error ? ` (${body.error})` : '';
    throw fail('failed', `token endpoint returned ${res.status}${why}`);
  }
  return body.id_token;
}

async function verifyIdToken(idToken, nonce) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) {
    throw fail('failed', 'ID token is not an RS256 JWT');
  }
  const key = await signingKey(decoded.header.kid);
  if (!key) throw fail('failed', `unknown signing key ${decoded.header.kid}`);
  let claims;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      audience: config().clientId,
      issuer: ISSUERS,
      clockTolerance: 60,
    });
  } catch (e) {
    throw fail('failed', `ID token rejected: ${e.message}`);
  }
  if (!constantTimeEqual(claims.nonce, nonce)) throw fail('failed', 'nonce mismatch');
  return claims;
}

// Code → verified identity → role. Throws an Error whose `code` is one of
// failed / unverified / not_allowed (and `email`, once known, for the audit
// log); the caller turns that into a /login?error= redirect.
async function completeFlow(code, flow) {
  const claims = await verifyIdToken(await exchangeCode(code, flow), flow.nonce);
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (!email || claims.email_verified !== true) {
    throw fail('unverified', 'Google account email is not verified', { email: email || null });
  }
  const role = roleFor(email);
  if (!role) throw fail('not_allowed', `${email} is not in OTHONI_ADMIN_EMAILS / OTHONI_VIEWER_EMAILS`, { email });
  return { email, role, sub: claims.sub };
}

module.exports = {
  CALLBACK_PATH,
  FLOW_TTL_MS,
  config,
  isConfigured,
  configProblems,
  roleFor,
  redirectUri,
  beginFlow,
  takeFlow,
  completeFlow,
};
