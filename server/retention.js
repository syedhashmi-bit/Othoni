'use strict';

// Per-metric retention overrides (v0.47). Some series benefit from
// longer retention than the global `OTHONI_RETENTION_MS` default — most
// notably `disk_root` for capacity planning. Each override is a
// pattern (exact metric name, or a glob using `*`) → TTL in ms. The
// longest-matching TTL wins per metric, so a broader override never
// shortens a more-specific one.
//
// Stored as JSON at `data/retention-overrides.json`, atomic write via
// tmp+rename. Loaded by `server/history.js` on each cleanup pass.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'retention-overrides.json');
const STORE_PATH = process.env.OTHONI_RETENTION_OVERRIDES_PATH || DEFAULT_PATH;

const MIN_TTL_MS = 60 * 1000;             // 1 min floor — anything shorter
                                          // would race the 10-min cleanup.
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year ceiling
const MAX_OVERRIDES = 64;
const MAX_PATTERN_LEN = 128;

// Same alphabet as the broader metric validator + `*` for globs.
const PATTERN_RE = /^[A-Za-z0-9._\-*]+$/;

let cache = null;
let regexes = null; // memoized compile of cache → [{ re, ttlMs }]

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && Array.isArray(parsed.overrides) ? parsed : { overrides: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`retention: read failed (${e.message}); starting empty`);
    cache = { overrides: [] };
  }
  regexes = null;
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_PATH);
  regexes = null;
}

function isValidPattern(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATTERN_LEN && PATTERN_RE.test(p);
}

function isValidTtl(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= MIN_TTL_MS && ms <= MAX_TTL_MS;
}

function compileRegexes() {
  if (regexes) return regexes;
  load();
  regexes = cache.overrides.map(({ pattern, ttlMs }) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return { pattern, re: new RegExp('^' + escaped + '$'), ttlMs };
  });
  return regexes;
}

// Largest TTL across every matching override; null when no override
// matches (caller falls back to the global default).
function effectiveTtl(metricName) {
  if (typeof metricName !== 'string') return null;
  const rs = compileRegexes();
  let best = null;
  for (const r of rs) {
    if (r.re.test(metricName) && (best == null || r.ttlMs > best)) best = r.ttlMs;
  }
  return best;
}

function list() {
  return load().overrides.slice();
}

// Replace the entire override list. The caller is the admin UI; we
// validate each row and refuse the whole batch on the first bad row
// so the operator gets an unambiguous error rather than partial state.
function setAll(next) {
  if (!Array.isArray(next)) {
    throw Object.assign(new Error('expected an array of { pattern, ttlMs }'), { code: 'invalid_request' });
  }
  if (next.length > MAX_OVERRIDES) {
    throw Object.assign(new Error(`at most ${MAX_OVERRIDES} overrides`), { code: 'invalid_request' });
  }
  const cleaned = [];
  const seen = new Set();
  for (const row of next) {
    if (!row || typeof row !== 'object') {
      throw Object.assign(new Error('each override must be { pattern, ttlMs }'), { code: 'invalid_request' });
    }
    if (!isValidPattern(row.pattern)) {
      throw Object.assign(
        new Error(`invalid pattern "${row.pattern}" — must match [A-Za-z0-9._\\-*]+`),
        { code: 'invalid_pattern' }
      );
    }
    if (!isValidTtl(row.ttlMs)) {
      throw Object.assign(
        new Error(`invalid ttlMs ${row.ttlMs} — must be ${MIN_TTL_MS}..${MAX_TTL_MS}`),
        { code: 'invalid_ttl' }
      );
    }
    if (seen.has(row.pattern)) {
      throw Object.assign(
        new Error(`duplicate pattern "${row.pattern}"`),
        { code: 'duplicate_pattern' }
      );
    }
    seen.add(row.pattern);
    cleaned.push({ pattern: row.pattern, ttlMs: row.ttlMs });
  }
  load();
  cache.overrides = cleaned;
  persist();
  return cleaned;
}

function reset() {
  cache = null;
  regexes = null;
}

module.exports = {
  list,
  setAll,
  effectiveTtl,
  isValidPattern,
  isValidTtl,
  reset,
  MIN_TTL_MS,
  MAX_TTL_MS,
};
