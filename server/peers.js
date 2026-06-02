'use strict';

// Federation peer registry. Each peer is another othoni instance running the
// full stack on a remote VPS, reachable over a trusted transport (WireGuard
// in the reference deployment). The central instance reverse-proxies
// read-only dashboard GETs to a peer via /api/fleet/:host/* (see
// routes/fleet.js), authenticating with the peer's OTHONI_PEER_TOKEN.
//
// Stored at data/peers.json (0600) as { peers: [{ host, url, token, label,
// addedAt }] }. The token is the peer's shared secret and is stored in
// plaintext — data/ is gitignored and local-only, and the central must be
// able to replay the token on every proxied request. listSafe() strips it
// for the API/UI.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'peers.json');

// Same DNS-style label the metrics ingest + host discovery use, so a peer's
// `host` lines up with the host-attributed `custom.<host>.*` series.
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

let storePath = process.env.OTHONI_PEERS_PATH || DEFAULT_PATH;
let cache = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && Array.isArray(parsed.peers) ? parsed : { peers: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`peers: read failed (${e.message}); starting fresh`);
    cache = { peers: [] };
  }
  return cache;
}

function persist() {
  ensureDir(storePath);
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  try { fs.chmodSync(storePath, 0o600); } catch { /* ignore */ }
}

function isValidHost(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 40 && HOST_RE.test(s);
}

// Only http/https, and never a non-http scheme that could be abused as an
// SSRF vector through the proxy. Returns the normalized origin (no path) or
// null. We deliberately allow private/loopback addresses — that's the whole
// point (WireGuard 10.8.0.x, localhost test peers).
function normalizeUrl(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  // Strip everything but origin — the proxy appends the sub-path itself.
  return u.origin;
}

function isValidToken(s) {
  return typeof s === 'string' && s.trim().length >= 16 && s.length <= 256;
}

function listSafe() {
  load();
  return cache.peers.map((p) => ({
    host: p.host,
    url: p.url,
    label: p.label || null,
    addedAt: p.addedAt,
    hasToken: !!p.token,
  }));
}

// Internal — includes the token. Used by the proxy only.
function getRaw(host) {
  load();
  return cache.peers.find((p) => p.host === host) || null;
}

function has(host) {
  return !!getRaw(host);
}

// Add or update a peer keyed by host. `token` is optional on update — when
// omitted, the existing token is kept (so the UI can edit url/label without
// re-entering the secret). On create the token is required.
function upsert({ host, url, token, label }) {
  load();
  if (!isValidHost(host)) {
    const e = new Error('host must be a DNS-style label [a-z0-9-]{1,40}');
    e.code = 'invalid_host';
    throw e;
  }
  const origin = normalizeUrl(url);
  if (!origin) {
    const e = new Error('url must be an http(s) URL');
    e.code = 'invalid_url';
    throw e;
  }
  const existing = cache.peers.find((p) => p.host === host);
  let tokenToStore;
  if (isValidToken(token)) {
    tokenToStore = token.trim();
  } else if (token == null && existing) {
    tokenToStore = existing.token;
  } else {
    const e = new Error('token must be at least 16 characters');
    e.code = 'invalid_token';
    throw e;
  }
  if (typeof label === 'string' && label.length > 80) {
    const e = new Error('label too long (max 80)');
    e.code = 'invalid_label';
    throw e;
  }
  const entry = {
    host,
    url: origin,
    token: tokenToStore,
    label: typeof label === 'string' && label.length ? label : (existing ? existing.label : null),
    addedAt: existing ? existing.addedAt : Date.now(),
  };
  if (existing) Object.assign(existing, entry);
  else cache.peers.push(entry);
  persist();
  const { token: _omit, ...safe } = entry;
  return { ...safe, hasToken: true };
}

function remove(host) {
  load();
  const before = cache.peers.length;
  cache.peers = cache.peers.filter((p) => p.host !== host);
  if (cache.peers.length === before) return false;
  persist();
  return true;
}

function reset() {
  cache = null;
}

function setStorePath(p) {
  storePath = p;
  reset();
}

module.exports = {
  listSafe,
  getRaw,
  has,
  upsert,
  remove,
  isValidHost,
  reset,
  setStorePath,
};
