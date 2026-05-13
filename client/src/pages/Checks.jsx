import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { IconPlus, IconTrash } from '../Icons.jsx';
import { useApp } from '../App.jsx';

const TYPES = [
  { value: 'http', label: 'HTTP', placeholder: 'https://example.com/health' },
  { value: 'tcp',  label: 'TCP',  placeholder: 'host:port (e.g. db.internal:5432)' },
  { value: 'ping', label: 'Ping', placeholder: 'host or IP (e.g. 1.1.1.1)' },
  { value: 'dns',  label: 'DNS',  placeholder: 'example.com|A (or just example.com)' },
];

const INTERVALS = [
  { value: 30,    label: '30 sec' },
  { value: 60,    label: '1 min' },
  { value: 300,   label: '5 min' },
  { value: 900,   label: '15 min' },
  { value: 3600,  label: '1 hour' },
];

function placeholderFor(type) {
  return TYPES.find((t) => t.value === type)?.placeholder || '';
}

function relativeTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StatusChip({ check }) {
  if (check.lastUp == null) {
    return <span className="chip"><span className="dot" />pending</span>;
  }
  if (check.lastUp === 1) {
    return (
      <span className="chip ok">
        <span className="dot" />
        up <strong>· {check.lastLatencyMs}ms</strong>
      </span>
    );
  }
  const sev = check.consecutiveFailures >= (check.alertAfterFailures || Infinity) ? 'crit' : 'warn';
  return (
    <span className={`chip ${sev}`}>
      <span className="dot" />
      down · ×{check.consecutiveFailures}
      {check.lastError && <span className="dim" style={{ marginLeft: 6 }}>{check.lastError}</span>}
    </span>
  );
}

// Lazy-loaded SLA stats row. Fetched once on expand, cached server-side 30s.
function StatsRow({ checkId }) {
  const [range, setRange] = useState('24h');
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setStats(null); setErr(null);
    api.checks.stats(checkId, range)
      .then((r) => setStats(r.stats))
      .catch((e) => setErr(e.body?.message || e.message));
  }, [checkId, range]);

  return (
    <div style={{ padding: '8px 16px 12px', background: 'var(--bg-card-2)' }}>
      <div className="toolbar" style={{ marginBottom: 8, gap: 4 }}>
        <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>Window:</span>
        {['15m', '1h', '6h', '24h'].map((r) => (
          <button
            key={r}
            type="button"
            className={`btn tiny ${r === range ? '' : 'ghost'}`}
            onClick={() => setRange(r)}
            style={{ padding: '2px 8px' }}
          >
            {r}
          </button>
        ))}
      </div>
      {err && <div className="error">{err}</div>}
      {!stats && !err && <div className="muted" style={{ fontSize: 12 }}>loading…</div>}
      {stats && (
        <div style={{
          display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
          fontSize: 12,
        }}>
          <Stat label="Samples" value={stats.samples ?? 0} />
          <Stat label="Uptime"  value={stats.uptimePercent != null ? `${stats.uptimePercent.toFixed(2)}%` : '—'} />
          <Stat label="p50"     value={fmtMs(stats.p50)} />
          <Stat label="p95"     value={fmtMs(stats.p95)} />
          <Stat label="p99"     value={fmtMs(stats.p99)} />
          <Stat label="min"     value={fmtMs(stats.min)} />
          <Stat label="max"     value={fmtMs(stats.max)} />
        </div>
      )}
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

// Optional body-assertion inputs. Shown only for HTTP / DNS types since the
// other types don't have a meaningful "body" to match against.
function AssertionFields({ form, setForm }) {
  if (form.type !== 'http' && form.type !== 'dns') return null;
  return (
    <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
        <span style={{ minWidth: 90 }}>Body regex</span>
        <input
          type="text"
          value={form.bodyRegex || ''}
          maxLength={256}
          onChange={(e) => setForm({ ...form, bodyRegex: e.target.value })}
          className="input mono"
          placeholder='e.g. "status":\s*"ok"'
          style={{ flex: 1, fontSize: 12 }}
        />
      </label>
      {form.type === 'http' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <span style={{ minWidth: 90 }}>JSON path</span>
          <input
            type="text"
            value={form.jsonPath || ''}
            maxLength={256}
            onChange={(e) => setForm({ ...form, jsonPath: e.target.value })}
            className="input mono"
            placeholder="e.g. status or data.health"
            style={{ flex: 1, fontSize: 12 }}
          />
        </label>
      )}
      {form.type === 'http' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
          <span style={{ minWidth: 90 }}>… equals</span>
          <input
            type="text"
            value={form.jsonPathEquals || ''}
            maxLength={256}
            onChange={(e) => setForm({ ...form, jsonPathEquals: e.target.value })}
            className="input mono"
            placeholder="optional — exact match"
            style={{ flex: 1, fontSize: 12 }}
            disabled={!form.jsonPath}
          />
        </label>
      )}
    </div>
  );
}

function AddCheckForm({ onCreated, onCancel }) {
  const [form, setForm] = useState({
    label: '',
    type: 'http',
    target: '',
    intervalSec: 60,
    timeoutMs: 5000,
    alertAfterFailures: 3,
    alertSeverity: 'warn',
    bodyRegex: '',
    jsonPath: '',
    jsonPathEquals: '',
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    // Strip empty assertion fields so they're saved as null server-side.
    const payload = { ...form };
    if (!payload.bodyRegex)      delete payload.bodyRegex;
    if (!payload.jsonPath)       delete payload.jsonPath;
    if (!payload.jsonPathEquals) delete payload.jsonPathEquals;
    try {
      const r = await api.checks.create(payload);
      onCreated(r.check);
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Label (e.g. main site, postgres, gateway)"
          value={form.label}
          maxLength={80}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          className="input"
        />
        <select
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value, target: '' })}
          className="select"
        >
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input
          type="text"
          placeholder={placeholderFor(form.type)}
          value={form.target}
          onChange={(e) => setForm({ ...form, target: e.target.value })}
          className="input mono"
          style={{ gridColumn: '1 / -1' }}
        />
        <AssertionFields form={form} setForm={setForm} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Interval
          <select
            value={form.intervalSec}
            onChange={(e) => setForm({ ...form, intervalSec: parseInt(e.target.value, 10) })}
            className="select"
          >
            {INTERVALS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Timeout
          <input
            type="number"
            value={form.timeoutMs}
            min={500} max={60000} step={500}
            onChange={(e) => setForm({ ...form, timeoutMs: parseInt(e.target.value, 10) })}
            className="input mono"
            style={{ width: 100 }}
          />
          <span className="dim" style={{ fontSize: 12 }}>ms</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Alert after
          <input
            type="number"
            value={form.alertAfterFailures}
            min={0} max={100} step={1}
            onChange={(e) => setForm({ ...form, alertAfterFailures: parseInt(e.target.value, 10) })}
            className="input mono"
            style={{ width: 60 }}
          />
          <span className="dim" style={{ fontSize: 12 }}>consecutive fails (0 = never)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Severity
          <select
            value={form.alertSeverity}
            onChange={(e) => setForm({ ...form, alertSeverity: e.target.value })}
            className="select"
          >
            <option value="warn">warn</option>
            <option value="crit">crit</option>
          </select>
        </label>
      </div>
      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
        <button type="submit" className="btn compact" disabled={busy}>
          {busy ? 'Saving…' : 'Save check'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function Checks() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(null);
  const [expanded, setExpanded] = useState(null); // check id with stats panel open

  function refresh() {
    api.checks.list().then((r) => setList(r.checks || [])).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  async function toggle(c) {
    try { await api.checks.update(c.id, { enabled: !c.enabled }); refresh(); }
    catch (e) { setErr(e.message); }
  }
  async function remove(c) {
    if (!confirm(`Remove check "${c.label}"?`)) return;
    try { await api.checks.remove(c.id); refresh(); }
    catch (e) { setErr(e.message); }
  }
  async function runNow(c) {
    setRunning(c.id);
    try { await api.checks.runNow(c.id); refresh(); }
    catch (e) { setErr(e.message); }
    finally { setRunning(null); }
  }

  const summary = list && list.length > 0
    ? {
        total:  list.length,
        up:     list.filter((c) => c.lastUp === 1).length,
        down:   list.filter((c) => c.lastUp === 0).length,
        pending:list.filter((c) => c.lastUp == null).length,
      }
    : null;

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Checks</h1>
      <p className="subtitle">
        Synthetic probes — HTTP / TCP / ICMP / DNS — recorded into the same
        history store as built-in metrics (<code>check.&lt;id&gt;.up</code> and{' '}
        <code>.latency_ms</code>). Click a row to see latency percentiles and
        uptime over a window.
      </p>

      {summary && (
        <div className="grid cols-4">
          <div className="stat-tile"><div className="label">Total</div><div className="value">{summary.total}</div></div>
          <div className="stat-tile ok"><div className="label">Up</div><div className="value">{summary.up}</div></div>
          <div className="stat-tile crit"><div className="label">Down</div><div className="value">{summary.down}</div></div>
          <div className="stat-tile dim"><div className="label">Pending</div><div className="value">{summary.pending}</div></div>
        </div>
      )}

      <div className="spacer-md" />

      <div className="toolbar">
        {!adding && isAdmin && (
          <button
            type="button"
            className="btn compact"
            onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <IconPlus /> Add check
          </button>
        )}
      </div>

      {err && <div className="error">{err}</div>}

      {adding && <AddCheckForm onCreated={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />}

      {list != null && list.length === 0 && !adding && (
        <div className="card empty" style={{ padding: 32 }}>
          No checks yet. Click <strong>Add check</strong> to set up an HTTP, TCP, ping, or DNS probe.
        </div>
      )}

      {list != null && list.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>On</th>
                  <th>Label</th>
                  <th style={{ width: 60 }}>Type</th>
                  <th>Target</th>
                  <th>Interval</th>
                  <th>Status</th>
                  <th>Last run</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <React.Fragment key={c.id}>
                    <tr
                      style={{ opacity: c.enabled ? 1 : 0.5, cursor: 'pointer' }}
                      onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={c.enabled}
                          onChange={() => toggle(c)}
                          aria-label="Enable check"
                          disabled={!isAdmin}
                        />
                      </td>
                      <td>{c.label}{c.steps?.length ? <span className="dim" style={{ marginLeft: 6, fontSize: 11 }}>{c.steps.length}-step</span> : null}</td>
                      <td className="mono muted" style={{ fontSize: 12 }}>{c.type}</td>
                      <td className="mono" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.target}>
                        {c.target || (c.steps?.length ? `${c.steps.length} chained requests` : '—')}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{c.intervalSec}s</td>
                      <td><StatusChip check={c} /></td>
                      <td className="muted" style={{ fontSize: 12 }}>{relativeTime(c.lastRunAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {isAdmin && (
                          <>
                            <button
                              type="button"
                              className="btn tiny"
                              onClick={() => runNow(c)}
                              disabled={running === c.id || !c.enabled}
                              style={{ marginRight: 6 }}
                            >
                              {running === c.id ? '…' : 'Run now'}
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => remove(c)}
                              title="Remove check"
                              aria-label="Remove check"
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expanded === c.id && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <StatsRow checkId={c.id} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
