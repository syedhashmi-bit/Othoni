import React, { useEffect, useState } from 'react';
import { api } from '../api';
import {
  notifyEnabled as readNotifyEnabled,
  setNotifyEnabled,
  formatDuration,
} from '../alerts';
import { IconPlus, IconTrash } from '../Icons.jsx';
import { useApp } from '../App.jsx';

const HISTORY_RANGES = [
  { value: '1h',  label: '1h' },
  { value: '6h',  label: '6h' },
  { value: '24h', label: '24h' },
];

function relativeTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

// Tiny bar histogram for per-rule fire density. ~24 buckets across the range,
// pure SVG, color follows severity. Keeps the table row compact.
function DensityBars({ points = [], from, to, severity = 'warn', width = 90, height = 22 }) {
  if (!points.length || !from || !to || to <= from) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="var(--border)" strokeWidth="1" />
      </svg>
    );
  }
  const max = points.reduce((m, p) => (p.v > m ? p.v : m), 1);
  const span = to - from;
  const barW = Math.max(1.5, width / Math.max(8, points.length * 1.4));
  const color = severity === 'crit' ? 'var(--crit)' : 'var(--warn)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} stroke="var(--border)" strokeWidth="0.5" />
      {points.map((p, i) => {
        const x = ((p.t - from) / span) * width;
        const h = Math.max(2, (p.v / max) * (height - 2));
        return (
          <rect
            key={i}
            x={x - barW / 2}
            y={height - h}
            width={barW}
            height={h}
            fill={color}
            opacity="0.85"
          />
        );
      })}
    </svg>
  );
}

const DURATIONS = [
  { ms: 0, label: 'immediate' },
  { ms: 60_000, label: '1 min' },
  { ms: 5 * 60_000, label: '5 min' },
  { ms: 15 * 60_000, label: '15 min' },
  { ms: 30 * 60_000, label: '30 min' },
];

const RATE_WINDOWS = [
  { ms: 60_000,        label: '1 min' },
  { ms: 5 * 60_000,    label: '5 min' },
  { ms: 15 * 60_000,   label: '15 min' },
  { ms: 30 * 60_000,   label: '30 min' },
  { ms: 60 * 60_000,   label: '1 hour' },
];

const COMPARATOR_OPTIONS = [
  { value: 'gt',      label: '> (above)' },
  { value: 'lt',      label: '< (below)' },
  { value: 'rate_gt', label: 'Δ/min > (rising faster than)' },
  { value: 'rate_lt', label: 'Δ/min < (falling faster than)' },
];

function isRateComparator(c) { return c === 'rate_gt' || c === 'rate_lt'; }

const FORMATS = [
  { value: 'generic', label: 'Generic JSON' },
  { value: 'slack',   label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'email',   label: 'Email (SMTP)' },
];

function newClientId() { return Math.random().toString(36).slice(2, 10); }

function unitFor(metric, metrics) {
  return metrics.find((m) => m.key === metric)?.unit || '';
}

function OnFireSummary({ onFire }) {
  if (!onFire || !onFire.enabled) {
    return <span className="muted" style={{ fontSize: 11 }}>no action</span>;
  }
  return (
    <span className="chip accent" style={{ fontSize: 11 }}>
      <span className="dot" />↪ {onFire.kind} {onFire.target}
    </span>
  );
}

function OnFireEditor({ onFire, actionsState, onChange }) {
  const enabled = !!actionsState?.enabled;
  const kinds = (actionsState?.kinds || []);
  const conf = onFire || { enabled: false, kind: '', target: '' };

  if (!enabled) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        Actions are disabled (<code>OTHONI_ACTIONS_ENABLED</code> unset).
        When enabled, you can wire a rule's fire to a systemd / Docker /
        process action, audit-logged and rate-limited per rule.
      </div>
    );
  }

  function update(patch) {
    const next = { ...conf, ...patch };
    onChange(next);
  }

  const allowedTargets = (kinds.find((k) => k.kind === conf.kind)?.allowedTargets) || null;

  return (
    <div style={{ fontSize: 12 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
        <input
          type="checkbox"
          checked={!!conf.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        Run an action when this rule fires
      </label>
      {conf.enabled && (
        <>
          <span style={{ marginRight: 6 }} className="muted">kind</span>
          <select
            className="select"
            value={conf.kind || ''}
            onChange={(e) => update({ kind: e.target.value, target: '' })}
            style={{ marginRight: 12 }}
          >
            <option value="">— select —</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>{k.kind}</option>
            ))}
          </select>
          <span style={{ marginRight: 6 }} className="muted">target</span>
          {allowedTargets ? (
            <select
              className="select"
              value={conf.target || ''}
              onChange={(e) => update({ target: e.target.value })}
            >
              <option value="">— select —</option>
              {allowedTargets.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="input mono"
              value={conf.target || ''}
              onChange={(e) => update({ target: e.target.value })}
              placeholder={
                conf.kind === 'process.signal'
                  ? 'PID (e.g. 1234)'
                  : conf.kind?.startsWith('docker.')
                    ? 'container name or id'
                    : 'target'
              }
              style={{ width: 220 }}
            />
          )}
          {conf.kind === 'process.signal' && (
            <>
              <span style={{ marginLeft: 12, marginRight: 6 }} className="muted">signal</span>
              <select
                className="select"
                value={conf.params?.signal || 'TERM'}
                onChange={(e) => update({ params: { ...(conf.params || {}), signal: e.target.value } })}
              >
                {['TERM', 'INT', 'HUP', 'USR1', 'USR2', 'KILL'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </>
          )}
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
            Cooldown: max(durationMs, 60s) between two dispatches per rule.
            Audit-logged. Actor recorded as <code>alert:{'<id>'}</code>.
          </div>
        </>
      )}
    </div>
  );
}

function RuleRow({ rule, active, metrics, stats, statsRange, actionsState, hosts = [], editable = true, onChange, onDelete }) {
  const sevColor = rule.severity === 'crit' ? 'var(--crit)' : 'var(--warn)';
  const isFiring = !!active;
  const [expanded, setExpanded] = React.useState(false);
  return (
    <React.Fragment>
    <tr style={{ opacity: rule.enabled ? 1 : 0.55 }}>
      <td>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          aria-label="Enable rule"
          disabled={!editable}
        />
      </td>
      <td>
        <input
          type="text"
          value={rule.label}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
          placeholder="(unnamed)"
          className="input"
          style={{ width: 170 }}
          disabled={!editable}
        />
      </td>
      <td>
        <select
          value={rule.metric}
          onChange={(e) => onChange({ ...rule, metric: e.target.value })}
          className="select"
          disabled={!editable}
        >
          {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
        <div style={{ marginTop: 4, fontSize: 11 }} className="muted">
          on{' '}
          <select
            value={rule.host || ''}
            onChange={(e) => {
              const v = e.target.value;
              const next = { ...rule };
              if (v) next.host = v; else delete next.host;
              onChange(next);
            }}
            className="select"
            style={{ padding: '1px 4px', fontSize: 11 }}
            disabled={!editable}
            title="Host scope. 'this box' uses the local snapshot; pick a host name to evaluate against custom.<host>.<metric>."
          >
            <option value="">this box</option>
            {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
            {/* Preserve a host name that's no longer in the list — e.g.
                the agent stopped reporting. */}
            {rule.host && !hosts.includes(rule.host) && (
              <option value={rule.host}>{rule.host} (offline)</option>
            )}
          </select>
        </div>
      </td>
      <td>
        <select
          value={rule.comparator}
          onChange={(e) => onChange({ ...rule, comparator: e.target.value })}
          className="select"
          style={{ width: 200 }}
          disabled={!editable}
        >
          {COMPARATOR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          value={rule.threshold}
          step={unitFor(rule.metric, metrics) === 'B/s' ? 100000 : unitFor(rule.metric, metrics) === '%' ? 1 : 0.1}
          onChange={(e) => onChange({ ...rule, threshold: parseFloat(e.target.value) || 0 })}
          className="input mono"
          style={{ width: 110 }}
          disabled={!editable}
        />
        <span className="dim" style={{ marginLeft: 6, fontSize: 12 }}>
          {unitFor(rule.metric, metrics)}{isRateComparator(rule.comparator) ? '/min' : ''}
        </span>
        {isRateComparator(rule.comparator) && (
          <div style={{ marginTop: 4, fontSize: 11 }} className="muted">
            over{' '}
            <select
              value={rule.rateWindowMs || 5 * 60_000}
              onChange={(e) => onChange({ ...rule, rateWindowMs: parseInt(e.target.value, 10) })}
              className="select"
              style={{ padding: '1px 4px', fontSize: 11 }}
              disabled={!editable}
            >
              {RATE_WINDOWS.map((w) => (
                <option key={w.ms} value={w.ms}>{w.label}</option>
              ))}
            </select>
          </div>
        )}
      </td>
      <td>
        <select
          value={rule.durationMs}
          onChange={(e) => onChange({ ...rule, durationMs: parseInt(e.target.value, 10) })}
          className="select"
          disabled={!editable}
        >
          {DURATIONS.map((d) => <option key={d.ms} value={d.ms}>{d.label}</option>)}
        </select>
      </td>
      <td>
        <select
          value={rule.severity}
          onChange={(e) => onChange({ ...rule, severity: e.target.value })}
          className="select"
          style={{ color: sevColor, fontWeight: 600 }}
          disabled={!editable}
        >
          <option value="warn">warn</option>
          <option value="crit">crit</option>
        </select>
      </td>
      <td className="mono" style={{ minWidth: 110 }}>
        {isFiring ? (
          <>
            <span style={{ color: sevColor }}>{active.valueFmt}</span>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>firing · {formatDuration(active.sustainedFor)}</div>
            {active.host && (
              <div className="dim" style={{ fontSize: 11 }}>on {active.host}</div>
            )}
          </>
        ) : (
          <span className="dim">—</span>
        )}
      </td>
      <td style={{ minWidth: 130 }}>
        {stats && stats.fires > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <DensityBars
              points={stats.points}
              from={statsRange?.from}
              to={statsRange?.to}
              severity={stats.lastSeverity || rule.severity}
            />
            <div style={{ lineHeight: 1.1 }}>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{stats.fires}×</div>
              <div className="dim" style={{ fontSize: 11 }}>{relativeTime(stats.lastFiredAt)}</div>
            </div>
          </div>
        ) : (
          <span className="dim">—</span>
        )}
      </td>
      <td>
        {editable && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete rule"
            title="Delete rule"
            className="icon-btn"
          >
            <IconTrash />
          </button>
        )}
      </td>
    </tr>
    <tr style={{ opacity: rule.enabled ? 1 : 0.55 }}>
      <td colSpan={10} style={{ borderTop: 'none', paddingTop: 2, paddingBottom: 10 }}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: 'var(--text-muted)',
            fontSize: 11,
          }}
        >
          <span className="muted">on fire</span>
          <OnFireSummary onFire={rule.onFire} />
          <span style={{ fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div style={{
            marginTop: 8,
            padding: 10,
            background: 'var(--bg-card-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
          }}>
            <OnFireEditor
              onFire={rule.onFire}
              actionsState={actionsState}
              onChange={(next) => onChange({ ...rule, onFire: next })}
            />
          </div>
        )}
      </td>
    </tr>
    </React.Fragment>
  );
}

function RecentFiresCard() {
  const [range, setRange] = useState('24h');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  function refresh() {
    api.alerts.history({ range, limit: 50 })
      .then(setData)
      .catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Recent fires</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Each row is one rule transition from non-firing to firing. Stored
            server-side; pruned with the 24h sample retention.
          </div>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {HISTORY_RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`btn tiny ${range === r.value ? 'active' : ''}`}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      {data && data.fires.length === 0 && (
        <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
          No fires in the last {range}. Either things are quiet, or the rules
          haven't been tested by real load yet.
        </div>
      )}

      {data && data.fires.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 140 }}>When</th>
                <th>Rule</th>
                <th>Severity</th>
                <th>Value · threshold</th>
                <th>Sustained</th>
              </tr>
            </thead>
            <tbody>
              {data.fires.map((f, i) => (
                <tr key={`${f.t}-${f.ruleId}-${i}`}>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {relativeTime(f.t)}
                    <div className="dim" style={{ fontSize: 11 }}>
                      {new Date(f.t).toLocaleTimeString([], { hour12: false })}
                    </div>
                  </td>
                  <td>
                    <div>
                      {f.label || <span className="dim">(unnamed)</span>}
                      {f.host && (
                        <span className="chip" style={{ marginLeft: 6, fontSize: 10 }}>
                          {f.host}
                        </span>
                      )}
                    </div>
                    <div className="dim mono" style={{ fontSize: 11 }}>{f.metric}</div>
                  </td>
                  <td>
                    <span className={`chip ${f.severity === 'crit' ? 'crit' : 'warn'}`}>
                      <span className="dot" />
                      {f.severity}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 13 }}>
                    {f.valueFmt ?? '—'}
                    <span className="dim" style={{ margin: '0 4px' }}>·</span>
                    <span className="dim">{f.thresholdFmt ?? '—'}</span>
                  </td>
                  <td className="mono muted" style={{ fontSize: 12 }}>
                    {formatDuration(f.sustainedMs || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Compact left-to-right strip of dots — one per delivery attempt. Last
// entry on the right is the most recent. Empty bullets fill from the
// left when fewer than `slots` attempts exist, so the live tip stays
// pinned right and the strip width doesn't jitter as it fills up.
function DeliveryStrip({ recent = [], slots = 12 }) {
  const items = [...recent];
  while (items.length < slots) items.unshift(null);
  return (
    <div style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      {items.map((d, i) => {
        const cls = d == null ? 'dim' : d.ok ? 'ok' : 'crit';
        const bg =
          d == null
            ? 'var(--bg-card-2)'
            : d.ok
            ? 'var(--ok)'
            : 'var(--crit)';
        const title = d
          ? `${d.ok ? '200 OK' : 'failed'} — ${new Date(d.t).toLocaleString([], { hour12: false })}`
          : '—';
        return (
          <span
            key={i}
            title={title}
            className={cls}
            style={{
              width: 6,
              height: 14,
              borderRadius: 2,
              background: bg,
              opacity: d == null ? 0.4 : 1,
              display: 'inline-block',
            }}
          />
        );
      })}
    </div>
  );
}

function DeliveryDetails({ webhookId }) {
  const [data, setData] = useState(null);
  const [range, setRange] = useState('24h');
  const [err, setErr] = useState(null);

  useEffect(() => {
    setData(null);
    api.webhooks
      .deliveries(webhookId, { range, limit: 100 })
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [webhookId, range]);

  return (
    <div style={{ padding: '10px 14px 14px', background: 'var(--bg-card-2)' }}>
      <div className="toolbar" style={{ marginTop: 0, marginBottom: 10 }}>
        {['1h', '6h', '24h'].map((r) => (
          <button
            key={r}
            type="button"
            className={`btn ghost ${range === r ? 'active' : ''}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 12 }}>
          {data ? (
            <>
              <span className="muted">total <strong className="mono">{data.stats.total}</strong></span>
              <span className="ok">ok <strong className="mono">{data.stats.ok}</strong></span>
              <span className="crit">fail <strong className="mono">{data.stats.fail}</strong></span>
              {data.stats.avgDurationMs != null && (
                <span className="muted">avg <strong className="mono">{data.stats.avgDurationMs}ms</strong></span>
              )}
            </>
          ) : (
            <span className="muted">loading…</span>
          )}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {data && data.deliveries.length === 0 && (
        <div className="empty" style={{ padding: '10px 0', fontSize: 12 }}>
          No deliveries in this range.
        </div>
      )}
      {data && data.deliveries.length > 0 && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 140 }}>When</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Duration</th>
                <th>Attempt</th>
                <th>Event</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((d, i) => (
                <tr key={`${d.t}-${i}`}>
                  <td className="muted" style={{ fontSize: 12 }}>{relativeTime(d.t)}</td>
                  <td>
                    <span className={`chip ${d.ok ? 'ok' : 'crit'}`} style={{ fontSize: 11 }}>
                      <span className="dot" />{d.ok ? 'ok' : 'fail'}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{d.statusCode ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {d.durationMs != null ? `${d.durationMs}ms` : '—'}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{d.attempt}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{d.eventLabel || '—'}</td>
                  <td className="mono crit" style={{ fontSize: 11 }}>{d.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WebhooksCard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [list, setList] = useState(null);
  const [smtp, setSmtp] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', url: '', format: 'generic', hostFilter: '' });
  const [err, setErr] = useState(null);
  const [testing, setTesting] = useState(null); // id being tested
  const [testResult, setTestResult] = useState({}); // { [id]: { ok, error } }
  const [expandedId, setExpandedId] = useState(null);
  const [filterDraft, setFilterDraft] = useState({}); // { [id]: pendingHostFilter }

  function refresh() {
    api.webhooks.list().then((r) => {
      setList(r.webhooks || []);
      setSmtp(r.smtp || null);
    }).catch((e) => setErr(e.message));
  }
  useEffect(() => { refresh(); }, []);

  async function create(e) {
    e?.preventDefault();
    setErr(null);
    if (!form.label.trim() || !form.url.trim()) return;
    try {
      await api.webhooks.create(form);
      setForm({ label: '', url: '', format: 'generic', hostFilter: '' });
      setAdding(false);
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    }
  }

  async function toggle(w) {
    try { await api.webhooks.update(w.id, { enabled: !w.enabled }); refresh(); }
    catch (e) { setErr(e.message); }
  }

  async function saveHostFilter(w) {
    const next = (filterDraft[w.id] ?? w.hostFilter ?? '').trim();
    try {
      await api.webhooks.update(w.id, { hostFilter: next });
      setFilterDraft((s) => { const c = { ...s }; delete c[w.id]; return c; });
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    }
  }
  async function remove(w) {
    if (!confirm(`Remove webhook "${w.label}"?`)) return;
    try { await api.webhooks.revoke(w.id); refresh(); }
    catch (e) { setErr(e.message); }
  }
  async function test(w) {
    setTesting(w.id);
    try {
      const r = await api.webhooks.test(w.id);
      setTestResult((s) => ({ ...s, [w.id]: r }));
    } catch (e) {
      setTestResult((s) => ({ ...s, [w.id]: { ok: false, error: e.message } }));
    } finally {
      setTesting(null);
      // The dispatch updates lastFiredAt / lastError on the server, refresh
      // so the Last fired column reflects it.
      setTimeout(refresh, 200);
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Webhooks</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Fired by the server when an alert transitions to firing — works
            even when no browser is open. Slack and Discord both accept the
            same JSON POST shape via incoming-webhook URLs. Email uses
            SMTP submission (OTHONI_SMTP_*).
            {smtp && smtp.enabled && (
              <span className="pill ok" style={{ fontSize: 10, marginLeft: 8 }}>
                SMTP · {smtp.host}:{smtp.port}
              </span>
            )}
            {smtp && !smtp.enabled && list && list.some((w) => w.format === 'email') && (
              <span className="pill crit" style={{ fontSize: 10, marginLeft: 8 }}>
                SMTP not configured
              </span>
            )}
          </div>
        </div>
        {!adding && isAdmin && (
          <button
            type="button"
            className="btn compact"
            onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <IconPlus /> Add webhook
          </button>
        )}
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      {adding && (
        <form onSubmit={create} className="toolbar" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Label (e.g. ops-slack)"
            value={form.label}
            maxLength={80}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            className="input"
            style={{ width: 180 }}
          />
          <input
            type={form.format === 'email' ? 'text' : 'url'}
            placeholder={form.format === 'email' ? 'ops@example.com (or mailto:…)' : 'https://hooks.slack.com/services/...'}
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            className="input grow mono"
          />
          <select
            value={form.format}
            onChange={(e) => setForm({ ...form, format: e.target.value })}
            className="select"
          >
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          {form.format === 'email' && smtp && !smtp.enabled && (
            <div className="muted" style={{ width: '100%', fontSize: 11, color: 'var(--warn)' }}>
              SMTP not configured. Set OTHONI_SMTP_HOST + OTHONI_SMTP_FROM in .env (and SMTP_USER/SMTP_PASS for authenticated submission) and restart.
            </div>
          )}
          <input
            type="text"
            placeholder="Host filter (blank = all, e.g. db-* or local)"
            value={form.hostFilter}
            maxLength={80}
            onChange={(e) => setForm({ ...form, hostFilter: e.target.value })}
            className="input mono"
            style={{ width: 220 }}
            title="Empty / * = all alerts. 'local' = local-box rules only. 'db-*' = glob match against rule.host. Exact name = only that host."
          />
          <button type="submit" className="btn compact">Save</button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => { setAdding(false); setForm({ label: '', url: '', format: 'generic', hostFilter: '' }); }}
          >
            Cancel
          </button>
        </form>
      )}

      {list != null && list.length === 0 && !adding && (
        <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
          No webhook destinations yet. Click <strong>Add webhook</strong> to wire up Slack, Discord, or any HTTP endpoint.
        </div>
      )}

      {list != null && list.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 40 }}>On</th>
                <th>Label</th>
                <th>Host</th>
                <th>Format</th>
                <th>Recent</th>
                <th>Last fired</th>
                <th>Status</th>
                <th style={{ width: 130 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => {
                const tr = testResult[w.id];
                const expanded = expandedId === w.id;
                return (
                  <React.Fragment key={w.id}>
                    <tr style={{ opacity: w.enabled ? 1 : 0.55 }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={w.enabled}
                          onChange={() => toggle(w)}
                          aria-label="Enable webhook"
                          disabled={!isAdmin}
                        />
                      </td>
                      <td>
                        {w.label}
                        {isAdmin ? (
                          <div style={{ marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span className="dim" style={{ fontSize: 11 }}>host:</span>
                            <input
                              type="text"
                              value={filterDraft[w.id] ?? w.hostFilter ?? ''}
                              placeholder="all"
                              maxLength={80}
                              onChange={(e) => setFilterDraft((s) => ({ ...s, [w.id]: e.target.value }))}
                              onBlur={() => {
                                const draft = filterDraft[w.id];
                                if (draft != null && draft !== (w.hostFilter || '')) saveHostFilter(w);
                              }}
                              className="input mono"
                              style={{ width: 130, padding: '1px 6px', fontSize: 11 }}
                              title="Empty / * = all. 'local' = local-box only. 'db-*' = glob."
                            />
                          </div>
                        ) : (
                          w.hostFilter ? (
                            <div className="dim mono" style={{ fontSize: 11 }}>host: {w.hostFilter}</div>
                          ) : null
                        )}
                      </td>
                      <td className="mono dim" style={{ fontSize: 12 }}>{w.host}</td>
                      <td className="muted">{w.format}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : w.id)}
                          style={{
                            background: 'transparent',
                            border: 0,
                            padding: 0,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            color: 'var(--text-muted)',
                          }}
                          title={expanded ? 'collapse delivery history' : 'expand delivery history'}
                        >
                          <DeliveryStrip recent={w.recent || []} />
                          <span className="muted" style={{ fontSize: 11 }}>{expanded ? '▾' : '▸'}</span>
                        </button>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {w.lastFiredAt ? new Date(w.lastFiredAt).toLocaleString([], { hour12: false }) : 'never'}
                      </td>
                      <td>
                        {testing === w.id ? (
                          <span className="chip"><span className="dot" />testing…</span>
                        ) : tr ? (
                          <span className={`chip ${tr.ok ? 'ok' : 'crit'}`}>
                            <span className="dot" />{tr.ok ? 'test ok' : (tr.error || 'failed')}
                          </span>
                        ) : w.lastError ? (
                          <span className="chip crit"><span className="dot" />{w.lastError}</span>
                        ) : w.lastFiredAt ? (
                          <span className="chip ok"><span className="dot" />ok</span>
                        ) : (
                          <span className="chip"><span className="dot" />idle</span>
                        )}
                      </td>
                      <td>
                        {isAdmin && (
                          <>
                            <button
                              type="button"
                              className="btn tiny"
                              onClick={() => test(w)}
                              disabled={testing === w.id}
                              style={{ marginRight: 6 }}
                            >
                              Test
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => remove(w)}
                              title="Remove webhook"
                              aria-label="Remove webhook"
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <DeliveryDetails webhookId={w.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Alerts() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [rules, setRules] = useState(null);
  const [active, setActive] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [stats, setStats] = useState(null); // { range, from, to, bucketMs, byRule: { id: { fires, lastFiredAt, points } } }
  const [actionsState, setActionsState] = useState(null);
  const [hostList, setHostList] = useState([]);
  const [err, setErr] = useState(null);
  const [notify, setNotify] = useState(readNotifyEnabled());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Action surface state — drives the "On fire" inline editor on each
  // rule. Polled once on mount; toggling OTHONI_ACTIONS_ENABLED needs a
  // service restart anyway.
  useEffect(() => {
    api.actions.list()
      .then(setActionsState)
      .catch(() => setActionsState({ enabled: false, kinds: [] }));
  }, []);

  // Host list for the per-host rule picker (v0.41). Re-fetch every 60s so
  // newly-onboarded hosts show up without a page reload. Stale-host
  // names already saved on a rule remain editable via the "(offline)"
  // option preserved in RuleRow.
  useEffect(() => {
    function refresh() {
      api.hosts()
        .then((r) => setHostList((r.hosts || []).map((h) => h.host)))
        .catch(() => { /* leave list empty; rules with host:'' still work */ });
    }
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  function loadAll() {
    Promise.all([api.alerts.rules(), api.alerts.active(), api.alerts.metrics()])
      .then(([r, a, m]) => {
        setRules(r.rules || []);
        setActive(a.active || []);
        setMetrics(m.metrics || []);
        setDirty(false);
      })
      .catch((e) => setErr(e.message));
  }
  useEffect(() => { loadAll(); }, []);

  // Refresh the "active" view every 5s so the Now column is roughly live.
  useEffect(() => {
    const id = setInterval(() => {
      api.alerts.active().then((a) => setActive(a.active || [])).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // 24h fire density per rule. Refresh on a slower cadence — the data only
  // changes on rule transitions, which are rare relative to the live state.
  useEffect(() => {
    function refresh() { api.alerts.stats('24h').then(setStats).catch(() => {}); }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  function update(id, next) {
    setRules(rules.map((r) => (r.id === id ? next : r)));
    setDirty(true);
  }
  function remove(id) {
    setRules(rules.filter((r) => r.id !== id));
    setDirty(true);
  }
  function add() {
    setRules([
      ...(rules || []),
      {
        id: newClientId(),
        enabled: true,
        metric: 'cpu',
        comparator: 'gt',
        threshold: 80,
        durationMs: 60_000,
        severity: 'warn',
        label: 'New rule',
      },
    ]);
    setDirty(true);
  }
  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await api.alerts.setRules(rules);
      setRules(r.rules || []);
      setDirty(false);
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setSaving(false);
    }
  }
  async function toggleNotify() {
    const ok = await setNotifyEnabled(!notify);
    setNotify(ok);
  }

  const activeById = Object.fromEntries(active.map((a) => [a.id, a]));

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Alerts</h1>
      <p className="subtitle">
        Threshold rules + webhook destinations evaluated server-side every
        10s. Edits are buffered locally until you click <strong>Save rules</strong>.
      </p>

      <div className="toolbar sticky">
        {isAdmin && (
          <>
            <button
              type="button"
              className="btn compact"
              onClick={add}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <IconPlus /> Add rule
            </button>
            <button
              type="button"
              className="btn compact"
              onClick={save}
              disabled={!dirty || saving}
              style={{ background: dirty ? 'var(--accent)' : 'var(--bg-elevated)', color: dirty ? 'white' : 'var(--text-muted)' }}
            >
              {saving ? 'Saving…' : dirty ? 'Save rules' : 'Saved'}
            </button>
          </>
        )}
        <label
          className="pushright"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <input type="checkbox" checked={notify} onChange={toggleNotify} />
          Browser notifications when rules fire
        </label>
      </div>

      {err && <div className="error">{err}</div>}

      {rules == null ? (
        <div className="loading">Loading rules…</div>
      ) : rules.length === 0 ? (
        <div className="card empty" style={{ padding: 32 }}>
          No rules yet. Click <strong>Add rule</strong> to create one.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>On</th>
                  <th>Label</th>
                  <th>Metric</th>
                  <th>Op</th>
                  <th>Threshold</th>
                  <th>Sustained</th>
                  <th>Severity</th>
                  <th>Now</th>
                  <th>Fires (24h)</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    active={activeById[r.id]}
                    metrics={metrics}
                    stats={stats?.byRule?.[r.id]}
                    statsRange={stats ? { from: stats.from, to: stats.to } : null}
                    actionsState={actionsState}
                    hosts={hostList}
                    editable={isAdmin}
                    onChange={(next) => update(r.id, next)}
                    onDelete={() => remove(r.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="spacer-md" />

      <RecentFiresCard />

      <div className="spacer-md" />

      <WebhooksCard />
    </div>
  );
}
