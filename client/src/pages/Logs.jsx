import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { usePoller } from '../hooks';

// Dropdown options. Priorities are journalctl-style — pass a number 0-7,
// "show this level and more severe". `null` here = no priority filter,
// i.e. show everything.
const PRIORITIES = [
  { value: 3, label: 'err and above (0–3)' },
  { value: 4, label: 'warning and above (0–4)' },
  { value: 5, label: 'notice and above (0–5)' },
  { value: 6, label: 'info and above (0–6)' },
  { value: 7, label: 'all (0–7)' },
];

const SINCE = [
  { value: '', label: 'no time bound' },
  { value: '5m', label: 'last 5 minutes' },
  { value: '15m', label: 'last 15 minutes' },
  { value: '1h', label: 'last hour' },
  { value: '6h', label: 'last 6 hours' },
  { value: '24h', label: 'last 24 hours' },
  { value: 'today', label: 'since midnight' },
];

const LIMITS = [50, 100, 200, 500, 1000];

const LEVEL_COLORS = {
  emerg: 'var(--crit)',
  alert: 'var(--crit)',
  crit: 'var(--crit)',
  err: 'var(--crit)',
  warning: 'var(--warn)',
  notice: 'var(--accent)',
  info: 'var(--text-muted)',
  debug: 'var(--text-dim)',
};

function chipVariantForLevel(level) {
  if (['emerg', 'alert', 'crit', 'err'].includes(level)) return 'crit';
  if (level === 'warning') return 'warn';
  if (level === 'notice') return 'accent';
  return '';
}

function LevelChip({ level }) {
  return (
    <span className={`chip ${chipVariantForLevel(level)}`} style={{ minWidth: 64, justifyContent: 'center', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5, fontWeight: 600 }}>
      {level}
    </span>
  );
}

function DisabledHint() {
  return (
    <div className="card" style={{ maxWidth: 720, marginTop: 16, padding: 24 }}>
      <div className="card-title" style={{ marginBottom: 10 }}>Logs collector disabled</div>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        The system logs feed is opt-in because journal entries can leak sensitive
        content (passwords / tokens / IPs in error messages, full command lines,
        kernel iptables logs with public IPs, etc.). Enable it explicitly:
      </p>
      <ol style={{ color: 'var(--text-muted)', paddingLeft: 20, lineHeight: 1.9 }}>
        <li>Add <code>OTHONI_LOGS_ENABLED=true</code> to <code>.env</code>.</li>
        <li>Restart: <code>sudo systemctl restart othoni</code>.</li>
        <li>Reload this page.</li>
      </ol>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 0 }}>
        The collector reads via <code>journalctl --output=json</code> (no shell).
        The othoni process must have permission to read the journal — that's
        automatic when running as <code>root</code>; otherwise add the service
        user to the <code>systemd-journal</code> group.
      </p>
    </div>
  );
}

const VALID_SINCE = new Set(SINCE.map((s) => s.value));

export default function Logs() {
  // Seed initial state from URL query params so deep links work
  // (e.g. from the alerts popover: /logs?since=15m&priority=4&unit=...).
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPriority = (() => {
    const v = parseInt(searchParams.get('priority') || '', 10);
    return Number.isFinite(v) && v >= 0 && v <= 7 ? v : 4;
  })();
  const initialSince = (() => {
    const v = searchParams.get('since') || '1h';
    return VALID_SINCE.has(v) ? v : '1h';
  })();
  const initialLimit = (() => {
    const v = parseInt(searchParams.get('limit') || '', 10);
    return LIMITS.includes(v) ? v : 200;
  })();
  const initialUnit = searchParams.get('unit') || '';

  const [priority, setPriority] = useState(initialPriority);
  const [since, setSince] = useState(initialSince);
  const [limit, setLimit] = useState(initialLimit);
  const [unit, setUnit] = useState(initialUnit);
  const [autoTail, setAutoTail] = useState(false);

  // Keep URL in sync with current filters so the page is shareable / refreshable.
  React.useEffect(() => {
    const params = {};
    if (priority !== 4) params.priority = String(priority);
    if (since && since !== '1h') params.since = since;
    if (limit !== 200) params.limit = String(limit);
    if (unit) params.unit = unit;
    setSearchParams(params, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority, since, limit, unit]);

  const loader = useCallback(
    () => api.logs({ limit, priority, unit: unit.trim() || null, since: since || null }),
    [limit, priority, unit, since]
  );
  const refreshMs = autoTail ? 5000 : 0;
  const { data, error, loading, refresh } = usePoller(
    loader,
    refreshMs || 24 * 60 * 60 * 1000, // effectively never if autoTail off — refresh button forces it
    [limit, priority, unit, since, autoTail]
  );

  if (data && !data.enabled) {
    return (
      <div className="page-fade-in">
        <h1 className="page-title">Logs</h1>
        <p className="subtitle">System log feed via journalctl.</p>
        <DisabledHint />
      </div>
    );
  }

  const entries = data?.entries || [];

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Logs</h1>
      <p className="subtitle">
        System log feed via <code>journalctl --output=json</code>.
        {data?.truncated && (
          <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
            (showing {entries.length} — there may be more)
          </span>
        )}
      </p>

      <div className="toolbar">
        <select value={priority} onChange={(e) => setPriority(parseInt(e.target.value, 10))} className="select">
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select value={since} onChange={(e) => setSince(e.target.value)} className="select">
          {SINCE.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          className="select"
        >
          {LIMITS.map((n) => <option key={n} value={n}>last {n}</option>)}
        </select>
        <input
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="filter by unit (e.g. nginx.service)"
          className="input mono grow"
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <input type="checkbox" checked={autoTail} onChange={(e) => setAutoTail(e.target.checked)} />
          auto-tail (5s)
        </label>
        <button type="button" className="btn ghost" onClick={refresh}>Refresh</button>
      </div>

      {loading && !data && <div className="loading">Loading logs…</div>}
      {error && !data && <div className="error">Could not read logs.</div>}

      {data && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 170 }}>Time</th>
                  <th style={{ width: 88 }}>Level</th>
                  <th style={{ width: 220 }}>Unit / Identifier</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {e.t ? new Date(e.t).toLocaleString([], { hour12: false }) : '—'}
                    </td>
                    <td><LevelChip level={e.level} /></td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {e.unit ? (
                        <span style={{ color: 'var(--accent)' }}>{e.unit}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>{e.identifier || '—'}</span>
                      )}
                      {e.pid ? <span className="dim"> [{e.pid}]</span> : null}
                    </td>
                    <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {e.message}
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      No log entries match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
