// Tiny fetch wrapper. The session cookie is sent automatically (same-origin).
// On state-changing methods (anything other than GET/HEAD), the v0.39
// CSRF double-submit pattern requires echoing the `othoni_csrf` cookie
// value back in the `X-Othoni-CSRF` header.
function readCsrfFromCookie() {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)othoni_csrf=([^;]+)/.exec(document.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const csrfHeaders = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const tok = readCsrfFromCookie();
    if (tok) csrfHeaders['X-Othoni-CSRF'] = tok;
  }
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...csrfHeaders,
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response — fall through
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `http_${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  health: () => request('/api/health'),
  me: () => request('/api/auth/me'),
  login: (username, password, totp) =>
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(totp ? { username, password, totp } : { username, password }),
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  overview: () => request('/api/overview'),
  hosts: () => request('/api/hosts'),
  hostDetail: (host) => request(`/api/hosts/${encodeURIComponent(host)}`),
  retention: {
    get: () => request('/api/retention'),
    set: (overrides) => request('/api/retention', {
      method: 'PUT', body: JSON.stringify({ overrides }),
    }),
  },
  vacuum: {
    status: () => request('/api/vacuum'),
    run:    () => request('/api/vacuum/run', { method: 'POST' }),
  },
  hostMeta: {
    list:   () => request('/api/host-meta'),
    upsert: (host, patch) => request(`/api/host-meta/${encodeURIComponent(host)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    }),
    remove: (host) => request(`/api/host-meta/${encodeURIComponent(host)}`, {
      method: 'DELETE',
    }),
  },
  actions: {
    list: () => request('/api/actions'),
    run: ({ kind, target, params, dryRun = false }) =>
      request('/api/actions/run', {
        method: 'POST',
        body: JSON.stringify({ kind, target, params, dryRun }),
      }),
    history: ({ range = '24h', kind = null, actor = null, outcome = null, limit = 100 } = {}) => {
      const qs = new URLSearchParams({ range, limit: String(limit) });
      if (kind) qs.set('kind', kind);
      if (actor) qs.set('actor', actor);
      if (outcome) qs.set('outcome', outcome);
      return request(`/api/actions/history?${qs.toString()}`);
    },
    historyActors: ({ range = '24h' } = {}) =>
      request(`/api/actions/history/actors?range=${encodeURIComponent(range)}`),
  },
  system: () => request('/api/system'),
  cpu: () => request('/api/cpu'),
  memory: () => request('/api/memory'),
  disks: () => request('/api/disks'),
  network: () => request('/api/network'),
  diskio: () => request('/api/diskio'),
  connections: () => request('/api/connections'),
  logs: ({ limit, priority, unit, since, until } = {}) => {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (priority != null) qs.set('priority', String(priority));
    if (unit) qs.set('unit', unit);
    if (since) qs.set('since', since);
    if (until != null) qs.set('until', String(until));
    const tail = qs.toString();
    return request(`/api/logs${tail ? `?${tail}` : ''}`);
  },
  processes: (sortBy = 'cpu', limit = 20) =>
    request(`/api/processes?sortBy=${sortBy}&limit=${limit}`),
  processTree: () => request('/api/processes/tree'),
  docker: () => request('/api/docker'),
  services: () => request('/api/services'),
  securityAudit: ({ force = false } = {}) =>
    request(`/api/security-audit${force ? '?force=1' : ''}`),
  securityHistory: (range = '7d') =>
    request(`/api/security-audit/history?range=${encodeURIComponent(range)}`),
  securityAcks: () => request('/api/security-audit/acks'),
  securityAck: ({ id, reason, ttlDays }) => request('/api/security-audit/ack', {
    method: 'POST',
    body: JSON.stringify({ id, reason, ttlDays }),
  }),
  securityUnack: (id) => request(`/api/security-audit/ack/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }),
  projects: {
    list: () => request('/api/projects'),
    control: (name, action) => request(`/api/projects/${encodeURIComponent(name)}/control`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  },
  settings: () => request('/api/settings'),
  dbStats: () => request('/api/db/stats'),
  sessions: {
    list:   () => request('/api/sessions'),
    revoke: (sid) => request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }),
  },
  audit: ({ range = '24h', action = null, limit = 200 } = {}) => {
    const qs = new URLSearchParams({ range, limit: String(limit) });
    if (action) qs.set('action', action);
    return request(`/api/audit?${qs.toString()}`);
  },
  auditActions: () => request('/api/audit/actions'),
  history: (metric, range = '1h') =>
    request(`/api/history?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`),
  historyMetrics: (prefix) =>
    request(`/api/history/metrics${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`),
  cpuCores: ({ range = '1h', buckets = 120 } = {}) =>
    request(`/api/history/cpu-cores?range=${encodeURIComponent(range)}&buckets=${buckets}`),
  historyProcesses: ({ range = '1h', sortBy = 'cpu', limit = 10 } = {}) => {
    const qs = new URLSearchParams({ range, sortBy, limit: String(limit) });
    return request(`/api/history/processes?${qs.toString()}`);
  },
  keys: {
    list:    () => request('/api/keys'),
    create:  (label) => request('/api/keys', { method: 'POST', body: JSON.stringify({ label }) }),
    revoke:  (id) => request(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  alerts: {
    rules:   () => request('/api/alerts/rules'),
    setRules: (rules) => request('/api/alerts/rules', {
      method: 'PUT', body: JSON.stringify({ rules }),
    }),
    active:  () => request('/api/alerts/active'),
    metrics: () => request('/api/alerts/metrics'),
    stats:   (range = '24h') => request(`/api/alerts/stats?range=${encodeURIComponent(range)}`),
    history: ({ range = '24h', limit = 100 } = {}) =>
      request(`/api/alerts/history?range=${encodeURIComponent(range)}&limit=${limit}`),
  },
  webhooks: {
    list:    () => request('/api/webhooks'),
    create:  ({ label, url, format, hostFilter }) => request('/api/webhooks', {
      method: 'POST', body: JSON.stringify({ label, url, format, hostFilter }),
    }),
    update:  (id, patch) => request(`/api/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
    revoke:  (id) => request(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    test:    (id) => request(`/api/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' }),
    deliveries: (id, { range = '24h', limit = 50 } = {}) =>
      request(`/api/webhooks/${encodeURIComponent(id)}/deliveries?range=${encodeURIComponent(range)}&limit=${limit}`),
  },
  checks: {
    list:    () => request('/api/checks'),
    create:  (payload) => request('/api/checks', {
      method: 'POST', body: JSON.stringify(payload),
    }),
    update:  (id, patch) => request(`/api/checks/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
    remove:  (id) => request(`/api/checks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    runNow:  (id) => request(`/api/checks/${encodeURIComponent(id)}/run`, { method: 'POST' }),
    stats:   (id, range = '24h') =>
      request(`/api/checks/${encodeURIComponent(id)}/stats?range=${encodeURIComponent(range)}`),
  },
};
