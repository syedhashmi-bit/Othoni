// Tiny fetch wrapper. The session cookie is sent automatically (same-origin).
async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
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
  system: () => request('/api/system'),
  cpu: () => request('/api/cpu'),
  memory: () => request('/api/memory'),
  disks: () => request('/api/disks'),
  network: () => request('/api/network'),
  diskio: () => request('/api/diskio'),
  connections: () => request('/api/connections'),
  logs: ({ limit, priority, unit, since } = {}) => {
    const qs = new URLSearchParams();
    if (limit != null) qs.set('limit', String(limit));
    if (priority != null) qs.set('priority', String(priority));
    if (unit) qs.set('unit', unit);
    if (since) qs.set('since', since);
    const tail = qs.toString();
    return request(`/api/logs${tail ? `?${tail}` : ''}`);
  },
  processes: (sortBy = 'cpu', limit = 20) =>
    request(`/api/processes?sortBy=${sortBy}&limit=${limit}`),
  docker: () => request('/api/docker'),
  services: () => request('/api/services'),
  settings: () => request('/api/settings'),
  history: (metric, range = '1h') =>
    request(`/api/history?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`),
  historyMetrics: (prefix) =>
    request(`/api/history/metrics${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`),
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
  },
  webhooks: {
    list:    () => request('/api/webhooks'),
    create:  ({ label, url, format }) => request('/api/webhooks', {
      method: 'POST', body: JSON.stringify({ label, url, format }),
    }),
    update:  (id, patch) => request(`/api/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
    revoke:  (id) => request(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    test:    (id) => request(`/api/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' }),
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
  },
};
