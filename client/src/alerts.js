// Alert rule engine — pure functions over a list of rules and a sequence of
// /api/overview snapshots. Rules + firing state both kept in memory; rules
// also persist to localStorage. No server-side state.

const STORAGE_KEY = 'othoni.alerts.rules';
const NOTIFY_KEY = 'othoni.alerts.notify';

// One entry per metric we know how to evaluate. `extract(overview)` returns
// the current numeric value, or null if the snapshot can't produce a value
// (e.g. swap when no swap is configured). `format(v)` is for the popover.
export const METRICS = {
  cpu: {
    label: 'CPU usage (%)',
    unit: '%',
    extract: (o) => o?.cpu?.usage ?? null,
    format: (v) => `${v.toFixed(1)}%`,
  },
  mem: {
    label: 'Memory usage (%)',
    unit: '%',
    extract: (o) => o?.memory?.usagePercent ?? null,
    format: (v) => `${v.toFixed(1)}%`,
  },
  swap: {
    label: 'Swap usage (%)',
    unit: '%',
    extract: (o) => (o?.memory?.swapTotal ? o.memory.swapPercent : null),
    format: (v) => `${v.toFixed(1)}%`,
  },
  load1: {
    label: 'Load average (1m)',
    unit: '',
    extract: (o) => o?.cpu?.loadAverage?.[0] ?? null,
    format: (v) => v.toFixed(2),
  },
  disk_root: {
    label: 'Root disk usage (%)',
    unit: '%',
    extract: (o) => {
      const root = (o?.disks?.disks || []).find((d) => d.mount === '/')
        || (o?.disks?.disks || [])[0];
      return root?.usagePercent ?? null;
    },
    format: (v) => `${v.toFixed(1)}%`,
  },
  net_rx: {
    label: 'Network in (B/s)',
    unit: 'B/s',
    extract: (o) => sumNonLoopback(o, 'rxBytesPerSec'),
    format: (v) => formatRate(v),
  },
  net_tx: {
    label: 'Network out (B/s)',
    unit: 'B/s',
    extract: (o) => sumNonLoopback(o, 'txBytesPerSec'),
    format: (v) => formatRate(v),
  },
  disk_read: {
    label: 'Disk read (B/s)',
    unit: 'B/s',
    extract: (o) => o?.diskio?.totalReadBytesPerSec ?? null,
    format: (v) => formatRate(v),
  },
  disk_write: {
    label: 'Disk write (B/s)',
    unit: 'B/s',
    extract: (o) => o?.diskio?.totalWriteBytesPerSec ?? null,
    format: (v) => formatRate(v),
  },
};

function sumNonLoopback(o, key) {
  const list = o?.network?.interfaces || [];
  if (!list.length) return null;
  return list.filter((i) => !i.isLoopback).reduce((s, i) => s + (i[key] || 0), 0);
}

function formatRate(v) {
  if (v == null) return '—';
  if (v < 1024) return `${v.toFixed(0)} B/s`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

// ---------- rule CRUD ----------

export function loadRules() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const rules = JSON.parse(raw);
    if (!Array.isArray(rules)) return null;
    return rules.filter(isValidRule);
  } catch {
    return null;
  }
}

export function saveRules(rules) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch {
    /* localStorage full / disabled — nothing we can do */
  }
}

function isValidRule(r) {
  return (
    r && typeof r === 'object'
    && typeof r.id === 'string'
    && METRICS[r.metric]
    && (r.comparator === 'gt' || r.comparator === 'lt')
    && typeof r.threshold === 'number' && Number.isFinite(r.threshold)
    && typeof r.durationMs === 'number' && r.durationMs >= 0
    && (r.severity === 'warn' || r.severity === 'crit')
  );
}

export function newRuleId() {
  return Math.random().toString(36).slice(2, 10);
}

// Reasonable starter rules so the page isn't empty on first load.
export function defaultRules() {
  return [
    {
      id: newRuleId(),
      enabled: true,
      metric: 'cpu',
      comparator: 'gt',
      threshold: 90,
      durationMs: 5 * 60_000,
      severity: 'warn',
      label: 'CPU sustained high',
    },
    {
      id: newRuleId(),
      enabled: true,
      metric: 'mem',
      comparator: 'gt',
      threshold: 90,
      durationMs: 5 * 60_000,
      severity: 'crit',
      label: 'Memory pressure',
    },
    {
      id: newRuleId(),
      enabled: true,
      metric: 'disk_root',
      comparator: 'gt',
      threshold: 90,
      durationMs: 60_000,
      severity: 'crit',
      label: 'Root disk almost full',
    },
  ];
}

// ---------- evaluation ----------

// State shape:
//   { ruleId: { firstBreachAt: number|null, firing: boolean, lastValue: number|null } }
// `evaluate` is pure-ish — it takes the previous state + new snapshot and returns
// the next state. Returns { state, fires, resolves } where:
//   - fires:    rules that just transitioned from non-firing to firing
//   - resolves: rules that just transitioned from firing to non-firing
export function evaluate(prevState, rules, overview, now = Date.now()) {
  const next = {};
  const fires = [];
  const resolves = [];
  for (const rule of rules) {
    const prev = prevState[rule.id] || { firstBreachAt: null, firing: false, lastValue: null };
    if (!rule.enabled) {
      next[rule.id] = { firstBreachAt: null, firing: false, lastValue: prev.lastValue };
      if (prev.firing) resolves.push(rule);
      continue;
    }
    const meta = METRICS[rule.metric];
    const value = meta?.extract(overview);
    if (value == null) {
      next[rule.id] = { firstBreachAt: null, firing: false, lastValue: null };
      if (prev.firing) resolves.push(rule);
      continue;
    }
    const breach = rule.comparator === 'gt'
      ? value > rule.threshold
      : value < rule.threshold;
    if (!breach) {
      next[rule.id] = { firstBreachAt: null, firing: false, lastValue: value };
      if (prev.firing) resolves.push(rule);
      continue;
    }
    const firstBreachAt = prev.firstBreachAt ?? now;
    const sustainedFor = now - firstBreachAt;
    const firing = sustainedFor >= rule.durationMs;
    next[rule.id] = { firstBreachAt, firing, lastValue: value };
    if (firing && !prev.firing) fires.push({ rule, value, sustainedFor });
  }
  return { state: next, fires, resolves };
}

// Project current "active alerts" view-model from rules + state — used by the
// notification dot and popover.
export function activeAlerts(rules, state) {
  const out = [];
  for (const rule of rules) {
    const s = state[rule.id];
    if (!s || !s.firing) continue;
    out.push({
      rule,
      value: s.lastValue,
      sustainedFor: Date.now() - (s.firstBreachAt || Date.now()),
    });
  }
  // Crit first, then warn, then by metric label for stability.
  out.sort((a, b) => {
    if (a.rule.severity !== b.rule.severity) return a.rule.severity === 'crit' ? -1 : 1;
    return (a.rule.label || a.rule.metric).localeCompare(b.rule.label || b.rule.metric);
  });
  return out;
}

// ---------- browser notifications (opt-in) ----------

export function notifyEnabled() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

export async function setNotifyEnabled(enabled) {
  if (!enabled) {
    try { localStorage.setItem(NOTIFY_KEY, '0'); } catch { /* ignore */ }
    return false;
  }
  if (typeof Notification === 'undefined') return false;
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { /* ignore */ }
  }
  if (perm !== 'granted') return false;
  try { localStorage.setItem(NOTIFY_KEY, '1'); } catch { /* ignore */ }
  return true;
}

export function notifyFire(rule, value) {
  if (!notifyEnabled()) return;
  const meta = METRICS[rule.metric];
  try {
    new Notification(`othoni · ${rule.severity === 'crit' ? 'CRITICAL' : 'warning'}`, {
      body: `${rule.label || meta.label} — currently ${meta.format(value)}`,
      tag: `othoni-${rule.id}`,
    });
  } catch {
    /* notification might have been disabled between checks */
  }
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}
