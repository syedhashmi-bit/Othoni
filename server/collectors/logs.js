'use strict';

const { run } = require('./exec');

// Linux syslog priority levels — same as RFC 5424 / systemd.
const PRIORITY_NAMES = {
  0: 'emerg',
  1: 'alert',
  2: 'crit',
  3: 'err',
  4: 'warning',
  5: 'notice',
  6: 'info',
  7: 'debug',
};

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function isEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.OTHONI_LOGS_ENABLED || ''));
}

// MESSAGE can be a string OR an array of byte values when the entry contains
// non-UTF-8 bytes. Normalize both shapes to a string.
function decodeMessage(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) {
    try {
      return Buffer.from(m).toString('utf8');
    } catch {
      return '';
    }
  }
  return String(m);
}

// __REALTIME_TIMESTAMP is microseconds since epoch as a decimal string.
function tsToMs(s) {
  if (!s) return null;
  const n = typeof s === 'number' ? s : parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n / 1000);
}

function parseEntry(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const priorityRaw = obj.PRIORITY != null ? parseInt(obj.PRIORITY, 10) : 6;
  const priority = Number.isFinite(priorityRaw) ? priorityRaw : 6;
  const unit = obj._SYSTEMD_UNIT || obj.UNIT || null;
  return {
    t: tsToMs(obj.__REALTIME_TIMESTAMP),
    cursor: obj.__CURSOR || null,
    priority,
    level: PRIORITY_NAMES[priority] || 'info',
    identifier: obj.SYSLOG_IDENTIFIER || obj._COMM || obj._EXE || '',
    unit,
    pid: obj._PID ? parseInt(obj._PID, 10) : null,
    hostname: obj._HOSTNAME || null,
    message: decodeMessage(obj.MESSAGE),
  };
}

// Build the journalctl argv from the requested filters. We DON'T interpolate
// any user input into a shell — we always pass via execFile, so units, since
// strings, etc. are arguments, not shell tokens.
function buildArgs({ limit, priority, unit, since, until }) {
  const args = ['--no-pager', '--output=json', `-n`, String(limit)];
  // priority can be a single value 0..7 ("up to and including this level")
  // or a "min..max" range. journalctl accepts numeric priorities directly.
  if (priority != null) {
    args.push('-p', String(priority));
  }
  if (unit) {
    args.push('-u', unit);
  }
  if (since) {
    args.push('--since', since);
  }
  if (until) {
    args.push('--until', until);
  }
  return args;
}

async function getLogs({ limit, priority, unit, since, until } = {}) {
  if (!isEnabled()) {
    const e = new Error('logs collector disabled — set OTHONI_LOGS_ENABLED=true');
    e.code = 'logs_disabled';
    throw e;
  }
  const lim = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT));
  const pri = priority != null && /^[0-7]$/.test(String(priority)) ? parseInt(priority, 10) : null;
  const u = unit && /^[A-Za-z0-9._@:\\-]{1,128}$/.test(unit) ? unit : null;
  // Whitelist `since` to a small set of human-readable forms — don't accept
  // arbitrary strings since journalctl interprets them in surprising ways
  // and we don't want users hammering with very expensive ranges.
  const sinceMap = {
    '5m': '5 minutes ago',
    '15m': '15 minutes ago',
    '1h': '1 hour ago',
    '6h': '6 hours ago',
    '24h': '24 hours ago',
    'today': 'today',
    'yesterday': 'yesterday',
  };
  const sinceArg = since && sinceMap[since] ? sinceMap[since] : null;
  // Pagination: client passes `until` as ms since epoch (the timestamp of the
  // oldest entry currently shown). journalctl accepts `@<unix-seconds>` as an
  // absolute time. We also post-filter strictly < untilMs to guard against
  // boundary entries sharing the same second.
  const untilMs = (Number.isFinite(parseInt(until, 10)) && parseInt(until, 10) > 0)
    ? parseInt(until, 10)
    : null;
  const untilArg = untilMs != null ? `@${Math.floor(untilMs / 1000)}` : null;

  const args = buildArgs({ limit: lim, priority: pri, unit: u, since: sinceArg, until: untilArg });
  const r = await run('journalctl', args, { timeout: 10_000 });
  if (!r.ok) {
    const e = new Error(`journalctl failed: ${r.stderr || 'unknown'}`);
    e.code = 'journalctl_failed';
    throw e;
  }

  const lines = r.stdout.split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseEntry(line);
    if (parsed) entries.push(parsed);
  }
  // journalctl -n N returns the last N entries oldest-first. Reverse so the
  // most recent is on top — that's what every log viewer expects.
  entries.reverse();
  // Strict-less-than enforcement on the boundary: `--until=@<sec>` is
  // inclusive of any entry within that second, which would re-deliver the
  // tail of the previous page when the client passes the oldest-shown ms.
  const filtered = untilMs != null ? entries.filter((e) => e.t != null && e.t < untilMs) : entries;

  return {
    enabled: true,
    entries: filtered,
    truncated: filtered.length >= lim,
    filter: { limit: lim, priority: pri, unit: u, since: sinceArg, untilMs },
  };
}

module.exports = { getLogs, isEnabled, PRIORITY_NAMES };
