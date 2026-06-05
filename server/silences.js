'use strict';

// Alert-rule silencing — temporary mute windows so a planned maintenance
// doesn't page anyone. Deliberately tiny: each silence is an absolute "mute
// until <timestamp>", either for one rule or for all rules (global). No
// recurring/cron schedules. The alert engine still *records* a suppressed fire
// to alert_fires (so the audit trail stays complete); it just skips webhook
// dispatch + wired actions while a silence is active.
//
// Stored at data/silences.json, same atomic tmp+rename pattern as the other
// small JSON stores. NOTE: distinct from v0.59's audit-finding snooze, which
// mutes *security-audit findings*, not alert rules.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'silences.json');
const STORE_PATH = process.env.OTHONI_SILENCES_PATH || DEFAULT_PATH;

const MAX_REASON = 200;
const MAX_MS = 30 * 24 * 3600 * 1000; // cap a single silence at 30 days

let cache = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    cache = parsed && Array.isArray(parsed.silences) ? parsed : { silences: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`silences: read failed (${e.message}); starting empty`);
    cache = { silences: [] };
  }
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

// Drop expired entries; persist only if something actually changed.
function prune(now = Date.now()) {
  load();
  const before = cache.silences.length;
  cache.silences = cache.silences.filter((s) => s.until > now);
  if (cache.silences.length !== before) persist();
}

function list(now = Date.now()) {
  prune(now);
  return cache.silences.slice();
}

function add({ scope, ruleId, durationMs, until, reason, actor } = {}) {
  load();
  const now = Date.now();
  let untilTs;
  if (until != null) untilTs = Number(until);
  else if (durationMs != null) untilTs = now + Number(durationMs);
  else throw Object.assign(new Error('need durationMs or until'), { code: 'invalid_request' });
  if (!Number.isFinite(untilTs) || untilTs <= now) {
    throw Object.assign(new Error('until must be a timestamp in the future'), { code: 'invalid_request' });
  }
  if (untilTs - now > MAX_MS) untilTs = now + MAX_MS; // clamp, don't reject

  const sc = scope === 'rule' ? 'rule' : 'global';
  if (sc === 'rule' && (typeof ruleId !== 'string' || !ruleId)) {
    throw Object.assign(new Error('ruleId is required for a rule-scoped silence'), { code: 'invalid_request' });
  }

  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    scope: sc,
    ruleId: sc === 'rule' ? ruleId : null,
    until: untilTs,
    reason: String(reason || '').slice(0, MAX_REASON),
    actor: actor || null,
    createdAt: now,
  };
  cache.silences.push(entry);
  persist();
  return entry;
}

function remove(id) {
  load();
  const before = cache.silences.length;
  cache.silences = cache.silences.filter((s) => s.id !== id);
  if (cache.silences.length === before) return false;
  persist();
  return true;
}

// Is this rule currently silenced? Returns the matching active silence (global
// wins if both apply) or null. Cheap — called once per fire in the alert tick.
function match(rule, now = Date.now()) {
  load();
  let hit = null;
  for (const s of cache.silences) {
    if (s.until <= now) continue;
    if (s.scope === 'global') return s; // global silences everything
    if (s.scope === 'rule' && rule && s.ruleId === rule.id) hit = s;
  }
  return hit;
}

function reset() { cache = null; }

module.exports = { list, add, remove, match, reset };
