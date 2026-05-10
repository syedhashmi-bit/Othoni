// Client-side helpers for the Alerts UI. The actual rule engine moved to
// the server in v0.11.0 (so webhooks fire even when no browser is open).
// What stays here: formatting helpers + browser-notification opt-in.

const NOTIFY_KEY = 'othoni.alerts.notify';

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export function notifyEnabled() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  try { return localStorage.getItem(NOTIFY_KEY) === '1'; }
  catch { return false; }
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

// Fire a browser notification for an active alert returned by /api/alerts/active.
export function notifyFire(active) {
  if (!notifyEnabled()) return;
  try {
    new Notification(`othoni · ${active.severity === 'crit' ? 'CRITICAL' : 'warning'}`, {
      body: `${active.label || active.metricLabel} — currently ${active.valueFmt}`,
      tag: `othoni-${active.id}`,
    });
  } catch { /* notification might have been disabled between checks */ }
}
