'use strict';

// Optional per-host metadata overlay. Keyed by host name (matches the
// `custom.<host>.*` ingest pattern). All fields optional; missing
// metadata for a host is the steady state and renders gracefully.
//
// Stored as a single JSON file (data/hosts.json) following the same
// pattern as webhooks.json / alert-rules.json — atomic write via
// tmp+rename so a crash mid-save can't leave a half-written file.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'hosts.json');
const STORE_PATH = process.env.OTHONI_HOST_META_PATH || DEFAULT_PATH;

const HOST_RE = /^([a-z0-9][a-z0-9-]{0,38}[a-z0-9]|[a-z0-9])$/;

const MAX_OWNER_LEN = 80;
const MAX_ENV_LEN = 40;
const MAX_TAG_LEN = 40;
const MAX_TAGS = 16;
const MAX_NOTES_LEN = 2000;
const MAX_PLACE_LEN = 60;

let cache = null;

// Coerce an optional latitude/longitude. Accepts a number or numeric string;
// an empty string or null clears the field (returns null). Throws on a
// non-numeric or out-of-range value.
function coerceCoord(v, max, label) {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < -max || n > max) {
    throw Object.assign(new Error(`${label} must be a number between -${max} and ${max}`), { code: 'invalid_request' });
  }
  return n;
}

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.byHost) {
      cache = parsed;
    } else {
      cache = { byHost: {} };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`host-meta: read failed (${e.message}); starting empty`);
    cache = { byHost: {} };
  }
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function isValidHost(s) {
  return typeof s === 'string' && HOST_RE.test(s);
}

// Normalize a patch — coerce types, clip strings, drop empties. Returns
// the cleaned object or throws on a hard validation failure. Empty
// strings are preserved as deletions (handled at the merge step).
function sanitizePatch(patch) {
  if (!patch || typeof patch !== 'object') {
    throw Object.assign(new Error('expected object'), { code: 'invalid_request' });
  }
  const out = {};
  if (patch.owner !== undefined) {
    if (typeof patch.owner !== 'string') throw Object.assign(new Error('owner must be string'), { code: 'invalid_request' });
    out.owner = patch.owner.slice(0, MAX_OWNER_LEN).trim();
  }
  if (patch.environment !== undefined) {
    if (typeof patch.environment !== 'string') throw Object.assign(new Error('environment must be string'), { code: 'invalid_request' });
    out.environment = patch.environment.slice(0, MAX_ENV_LEN).trim();
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) throw Object.assign(new Error('tags must be array'), { code: 'invalid_request' });
    out.tags = patch.tags
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .slice(0, MAX_TAGS)
      .map((t) => t.trim().slice(0, MAX_TAG_LEN));
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== 'string') throw Object.assign(new Error('notes must be string'), { code: 'invalid_request' });
    out.notes = patch.notes.slice(0, MAX_NOTES_LEN);
  }
  if (patch.lat !== undefined) out.lat = coerceCoord(patch.lat, 90, 'lat');
  if (patch.lon !== undefined) out.lon = coerceCoord(patch.lon, 180, 'lon');
  if (patch.place !== undefined) {
    if (typeof patch.place !== 'string') throw Object.assign(new Error('place must be string'), { code: 'invalid_request' });
    out.place = patch.place.slice(0, MAX_PLACE_LEN).trim();
  }
  return out;
}

function isEmptyEntry(entry) {
  if (!entry) return true;
  const { owner, environment, tags, notes, lat, lon, place } = entry;
  return (
    !owner &&
    !environment &&
    (!Array.isArray(tags) || tags.length === 0) &&
    !notes &&
    lat == null &&
    lon == null &&
    !place
  );
}

function get(host) {
  if (!isValidHost(host)) return null;
  return load().byHost[host] || null;
}

// Map of host → metadata. Used by /api/hosts to overlay onto live host
// discovery, and by /api/host-meta to expose the raw store to the UI.
function all() {
  return { ...(load().byHost || {}) };
}

function upsert(host, patch) {
  if (!isValidHost(host)) {
    throw Object.assign(new Error('host must match [a-z0-9-]{1,40}'), { code: 'invalid_host' });
  }
  const cleaned = sanitizePatch(patch);
  load();
  const prev = cache.byHost[host] || {};
  const next = { ...prev, ...cleaned };
  // A cleared coordinate / place comes through as null / '' — drop the key
  // rather than persist an empty value.
  if (next.lat == null) delete next.lat;
  if (next.lon == null) delete next.lon;
  if (!next.place) delete next.place;
  if (isEmptyEntry(next)) {
    delete cache.byHost[host];
  } else {
    cache.byHost[host] = next;
  }
  persist();
  return cache.byHost[host] || null;
}

function remove(host) {
  if (!isValidHost(host)) return false;
  load();
  if (!(host in cache.byHost)) return false;
  delete cache.byHost[host];
  persist();
  return true;
}

function reset() { cache = null; }

module.exports = {
  get, all, upsert, remove,
  isValidHost,
  reset,
};
