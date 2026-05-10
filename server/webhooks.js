'use strict';

// Webhook destinations — fired by the server-side alert engine when a rule
// transitions to firing. Three formats supported: `generic` (full JSON
// payload), `slack` (text in `text` field), `discord` (text in `content`
// field). Both Slack and Discord accept a JSON POST to their incoming-
// webhook URLs and both render `\n` as newlines.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'webhooks.json');
const STORE_PATH = process.env.OTHONI_WEBHOOKS_PATH || DEFAULT_PATH;
const TIMEOUT_MS = 8000;
const RETRY_AFTER_MS = 1500; // single retry delay

const VALID_FORMATS = ['generic', 'slack', 'discord'];

let cache = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && Array.isArray(parsed.webhooks) ? parsed : { webhooks: [] };
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`webhooks: read failed (${e.message}); starting fresh`);
    cache = { webhooks: [] };
  }
  return cache;
}

function persist() {
  ensureDir(STORE_PATH);
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function newId() { return crypto.randomBytes(6).toString('hex'); }

function isValidUrl(s) {
  if (typeof s !== 'string' || s.length > 2000) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch { return false; }
}

function sanitize(w) {
  // Never return the URL through the API — it's the secret. Only the
  // host portion is exposed so the user can recognize the destination.
  let host = '';
  try { host = new URL(w.url).hostname; } catch { /* ignore */ }
  return {
    id: w.id,
    label: w.label,
    format: w.format,
    enabled: w.enabled !== false,
    host,
    createdAt: w.createdAt,
    lastFiredAt: w.lastFiredAt || null,
    lastError: w.lastError || null,
  };
}

function listWebhooks() {
  load();
  return cache.webhooks.map(sanitize);
}

function createWebhook({ label, url, format }) {
  if (typeof label !== 'string' || !label.trim() || label.length > 80) {
    throw Object.assign(new Error('label must be 1–80 chars'), { code: 'invalid_label' });
  }
  if (!isValidUrl(url)) {
    throw Object.assign(new Error('url must be http:// or https://'), { code: 'invalid_url' });
  }
  const fmt = VALID_FORMATS.includes(format) ? format : 'generic';
  load();
  const w = {
    id: newId(),
    label: label.trim(),
    url,
    format: fmt,
    enabled: true,
    createdAt: Date.now(),
    lastFiredAt: null,
    lastError: null,
  };
  cache.webhooks.push(w);
  persist();
  return sanitize(w);
}

function updateWebhook(id, patch) {
  load();
  const w = cache.webhooks.find((x) => x.id === id);
  if (!w) return null;
  if (typeof patch.enabled === 'boolean') w.enabled = patch.enabled;
  if (typeof patch.label === 'string' && patch.label.trim() && patch.label.length <= 80) {
    w.label = patch.label.trim();
  }
  persist();
  return sanitize(w);
}

function revokeWebhook(id) {
  load();
  const before = cache.webhooks.length;
  cache.webhooks = cache.webhooks.filter((w) => w.id !== id);
  if (cache.webhooks.length === before) return false;
  persist();
  return true;
}

// ---------- formatters ----------

function durationStr(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function defaultText(event) {
  const r = event.rule;
  const sev = (r.severity || 'warn').toUpperCase();
  return `[${sev}] ${r.label || r.metric} — ${event.valueFmt} ${r.comparator === 'gt' ? '>' : '<'} ${event.thresholdFmt} (sustained ${durationStr(event.sustainedFor)})`;
}

function formatPayload(format, event) {
  if (format === 'slack')   return { text: defaultText(event) };
  if (format === 'discord') return { content: defaultText(event) };
  // generic — full payload, useful for custom integrations
  return {
    event: 'alert.fire',
    text: defaultText(event),
    rule: {
      id: event.rule.id,
      label: event.rule.label,
      metric: event.rule.metric,
      comparator: event.rule.comparator,
      threshold: event.rule.threshold,
      severity: event.rule.severity,
    },
    value: event.value,
    valueFmt: event.valueFmt,
    sustainedMs: event.sustainedFor,
    timestamp: Date.now(),
    host: require('os').hostname(),
  };
}

// ---------- dispatcher ----------

async function postWithTimeout(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'othoni-webhook/1' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } finally {
    clearTimeout(t);
  }
}

async function fireOne(w, event) {
  const body = formatPayload(w.format, event);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await postWithTimeout(w.url, body);
      // Update success metadata
      w.lastFiredAt = Date.now();
      w.lastError = null;
      persist();
      return true;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    }
  }
  w.lastError = (lastErr && lastErr.message) || 'unknown';
  w.lastFiredAt = Date.now();
  persist();
  logger.warn(`webhook "${w.label}" failed: ${w.lastError}`);
  return false;
}

// Called by the alert engine on each rule fire. Fires every enabled webhook
// in parallel (don't await — let them race; failures are logged).
function dispatch(event) {
  load();
  for (const w of cache.webhooks) {
    if (!w.enabled) continue;
    fireOne(w, event).catch(() => { /* already logged by fireOne */ });
  }
}

// Fire a synthetic "test" event against a single webhook by id. Used by the
// "Test" button in the dashboard so the user can verify connectivity without
// waiting for a real alert.
async function testWebhook(id) {
  load();
  const w = cache.webhooks.find((x) => x.id === id);
  if (!w) return { ok: false, error: 'not_found' };
  const event = {
    rule: { id: 'test', label: 'webhook test', metric: 'cpu', comparator: 'gt', threshold: 0, severity: 'warn' },
    value: 0,
    valueFmt: '(test)',
    thresholdFmt: '(test)',
    sustainedFor: 0,
  };
  const ok = await fireOne(w, event);
  return { ok, error: ok ? null : (w.lastError || 'unknown') };
}

function reset() { cache = null; }

module.exports = {
  listWebhooks,
  createWebhook,
  updateWebhook,
  revokeWebhook,
  dispatch,
  testWebhook,
  reset,
};
