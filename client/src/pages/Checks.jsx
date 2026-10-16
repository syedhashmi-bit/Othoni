import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { IconPlus, IconTrash } from '../Icons.jsx';
import { useApp } from '../App.jsx';
import { Sparkline } from '../Charts.jsx';
import { useLocalSetting } from '../hooks.js';

const TYPES = [
  { value: 'http', label: 'HTTP', placeholder: 'https://example.com/health' },
  { value: 'tcp',  label: 'TCP',  placeholder: 'host:port (e.g. db.internal:5432)' },
  { value: 'ping', label: 'Ping', placeholder: 'host or IP (e.g. 1.1.1.1)' },
  { value: 'dns',  label: 'DNS',  placeholder: 'example.com|A (or just example.com)' },
  { value: 'tls',       label: 'TLS cert',     placeholder: 'host or host:port (e.g. example.com)' },
  { value: 'domain',    label: 'Domain expiry', placeholder: 'registered domain (e.g. example.com)' },
  { value: 'heartbeat', label: 'Heartbeat',    placeholder: '' },
];

const INTERVALS = [
  { value: 30,    label: '30 sec' },
  { value: 60,    label: '1 min' },
  { value: 300,   label: '5 min' },
  { value: 900,   label: '15 min' },
  { value: 3600,  label: '1 hour' },
  { value: 21600, label: '6 hours' },
  { value: 86400, label: '1 day' },
];

// Sensible starting interval per type — certs and registrations change
// slowly, and a heartbeat's interval is "how often the job runs".
const DEFAULT_INTERVAL = { tls: 3600, domain: 86400, heartbeat: 86400 };

function placeholderFor(type) {
  return TYPES.find((t) => t.value === type)?.placeholder || '';
}

function pingUrl(token) {
  return `${window.location.origin}/ping/${token}`;
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

function fmtInterval(sec) {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0)  return `${sec / 3600}h`;
  if (sec % 60 === 0)    return `${sec / 60}m`;
  return `${sec}s`;
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
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

// Per-type options for the Sentinel-derived checks.
function TypeOptions({ form, setForm }) {
  const rowStyle = { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 };
  if (form.type === 'tls' || form.type === 'domain') {
    return (
      <label style={rowStyle}>
        Warn when fewer than
        <input
          type="number"
          value={form.warnDays}
          min={0} max={365} step={1}
          onChange={(e) => setForm({ ...form, warnDays: parseInt(e.target.value, 10) })}
          className="input mono"
          style={{ width: 70 }}
        />
        <span className="dim" style={{ fontSize: 12 }}>
          days remain{form.type === 'tls' ? ' — also fails on an invalid chain or hostname mismatch' : ''}
        </span>
      </label>
    );
  }
  if (form.type === 'heartbeat') {
    return (
      <label style={rowStyle}>
        Grace
        <input
          type="number"
          value={form.graceSec}
          min={0} step={60}
          onChange={(e) => setForm({ ...form, graceSec: parseInt(e.target.value, 10) })}
          className="input mono"
          style={{ width: 90 }}
        />
        <span className="dim" style={{ fontSize: 12 }}>
          sec of slack after the interval. A ping URL is generated on save — have your job <code>curl</code> it.
        </span>
      </label>
    );
  }
  if (form.type === 'dns') {
    return (
      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={!!form.trackChanges}
          onChange={(e) => setForm({ ...form, trackChanges: e.target.checked })}
        />
        Alert when the records change (first answer is pinned as the baseline)
      </label>
    );
  }
  return null;
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
    warnDays: 14,
    graceSec: 300,
    trackChanges: false,
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
          onChange={(e) => {
            const type = e.target.value;
            setForm({
              ...form, type, target: '',
              intervalSec: DEFAULT_INTERVAL[type] || 60,
              warnDays: type === 'domain' ? 30 : 14,
              alertAfterFailures: ['tls', 'domain', 'heartbeat'].includes(type) ? 1 : 3,
            });
          }}
          className="select"
        >
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {form.type !== 'heartbeat' && (
          <input
            type="text"
            placeholder={placeholderFor(form.type)}
            value={form.target}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
            className="input mono"
            style={{ gridColumn: '1 / -1' }}
          />
        )}
        <TypeOptions form={form} setForm={setForm} />
        <AssertionFields form={form} setForm={setForm} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          {form.type === 'heartbeat' ? 'Expect a ping every' : 'Interval'}
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

// ---------- grouped overview (v0.75) ----------

// Human names for each check type; the short tag is the protocol.
const KIND = {
  http:      { name: 'Website',      tag: 'HTTP' },
  tcp:       { name: 'Port',         tag: 'TCP' },
  ping:      { name: 'Reachability', tag: 'ICMP' },
  dns:       { name: 'DNS records',  tag: 'DNS' },
  tls:       { name: 'Certificate',  tag: 'TLS' },
  domain:    { name: 'Registration', tag: 'RDAP' },
  heartbeat: { name: 'Heartbeat',    tag: 'PING' },
};

const LATENCY_TYPES = new Set(['http', 'tcp', 'ping']);

const FILTERS = [
  { key: 'all',       label: 'All',          match: () => true },
  { key: 'failing',   label: 'Failing',      match: (c) => c.enabled && c.lastUp === 0 },
  { key: 'web',       label: 'Websites',     match: (c) => LATENCY_TYPES.has(c.type) },
  { key: 'tls',       label: 'Certificates', match: (c) => c.type === 'tls' },
  { key: 'dns',       label: 'DNS',          match: (c) => c.type === 'dns' },
  { key: 'domain',    label: 'Domains',      match: (c) => c.type === 'domain' },
  { key: 'heartbeat', label: 'Heartbeats',   match: (c) => c.type === 'heartbeat' },
];

// Checks are grouped by the host they watch, so a site's website / cert /
// DNS checks sit together. Registrations and heartbeats get their own group.
function groupKey(c) {
  if (c.type === 'heartbeat') return 'Heartbeats';
  if (c.type === 'domain') return 'Domain registrations';
  const t = c.target || c.steps?.[0]?.url || '';
  if (c.type === 'http') {
    try { return new URL(t).hostname; } catch { return t || 'Other'; }
  }
  if (c.type === 'dns') return t.split('|')[0] || 'Other';
  return t.replace(/:\d+$/, '') || 'Other';
}

function stateOf(c) {
  if (!c.enabled) return 'paused';
  if (c.lastUp == null) return 'pending';
  if (c.lastUp === 1) return 'ok';
  return c.alertAfterFailures > 0 && c.consecutiveFailures >= c.alertAfterFailures ? 'crit' : 'warn';
}

const STATE_LABEL = { ok: 'Passing', warn: 'Failing', crit: 'Alerting', pending: 'Pending', paused: 'Paused' };

// Ordering inside a group: failures first, then by type in a fixed order.
const TYPE_ORDER = ['http', 'tcp', 'ping', 'tls', 'dns', 'domain', 'heartbeat'];
const STATE_ORDER = { crit: 0, warn: 1, pending: 2, ok: 3, paused: 4 };

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function IconRun(props) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
  );
}
function IconPause(props) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
      <path d="M9 5v14M15 5v14" />
    </svg>
  );
}
function IconResume(props) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M8 5.5v13a.5.5 0 0 0 .77.42l10-6.5a.5.5 0 0 0 0-.84l-10-6.5A.5.5 0 0 0 8 5.5z" />
    </svg>
  );
}

// Days-left meter for certs and registrations. The bar spans a natural
// horizon (90 d for Let's Encrypt-style certs, a year for registrations).
function DaysMeter({ check }) {
  const d = check.detail;
  if (!d || typeof d.daysLeft !== 'number') return <span className="dim">—</span>;
  const horizon = check.type === 'tls' ? 90 : 365;
  const warn = check.warnDays ?? (check.type === 'tls' ? 14 : 30);
  const tone = d.daysLeft < warn ? 'crit' : d.daysLeft < warn * 2 ? 'warn' : 'ok';
  const pct = Math.max(2, Math.min(100, (d.daysLeft / horizon) * 100));
  return (
    <div className="ck-days">
      <div className="ck-days-top">
        <span className={`ck-big ${tone}`}>{d.daysLeft}<small> days left</small></span>
        <span className="dim">{d.issuer || `expires ${fmtDate(d.expiresAt)}`}</span>
      </div>
      <div className="ck-bar"><span className={tone} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// The middle column: whatever single fact best describes this check now.
function MetricCell({ check, spark }) {
  const st = stateOf(check);
  if ((st === 'warn' || st === 'crit') && check.lastError && !['tls', 'domain'].includes(check.type)) {
    return (
      <div className="ck-error" title={check.lastError}>
        {check.lastError}
        <span className="dim"> · {check.consecutiveFailures}× in a row</span>
      </div>
    );
  }
  if (LATENCY_TYPES.has(check.type)) {
    return (
      <div className="ck-latency">
        <span className="ck-big">{check.lastLatencyMs != null ? fmtMs(check.lastLatencyMs) : '—'}</span>
        <div className="ck-spark">
          {spark && spark.length > 1
            ? <Sparkline points={spark} height={26} color="var(--accent)" />
            : <span className="dim" style={{ fontSize: 11 }}>collecting…</span>}
        </div>
      </div>
    );
  }
  if (check.type === 'tls' || check.type === 'domain') return <DaysMeter check={check} />;
  if (check.type === 'dns') {
    const recs = check.detail?.records || check.dnsBaseline;
    return (
      <div className="ck-dns">
        <span className="mono">{recs || '—'}</span>
        {check.trackChanges && <span className="ck-tag">pinned</span>}
      </div>
    );
  }
  if (check.type === 'heartbeat') {
    return (
      <div className="ck-dns">
        <span>{check.lastPingAt ? `Last ping ${relativeTime(check.lastPingAt)}` : 'Waiting for first ping'}</span>
      </div>
    );
  }
  return null;
}

// Expanded panel: latency checks get the SLA stats; everything else gets a
// plain fact sheet.
function DetailPanel({ check }) {
  const rows = [['Target', check.target || (check.steps?.length ? `${check.steps.length} chained requests` : '—')]];
  if (check.type === 'heartbeat' && check.hbToken) rows[0] = ['Ping URL', pingUrl(check.hbToken)];
  if (check.detail?.expiresAt) rows.push(['Expires', fmtDate(check.detail.expiresAt)]);
  if (check.detail?.issuer) rows.push(['Issuer', check.detail.issuer]);
  if (check.warnDays != null) rows.push(['Warn below', `${check.warnDays} days`]);
  if (check.type === 'dns' && check.trackChanges) rows.push(['Pinned baseline', check.dnsBaseline || '—']);
  if (check.type === 'heartbeat') {
    rows.push(['Expected every', fmtInterval(check.intervalSec)]);
    rows.push(['Grace', fmtInterval(check.graceSec || 0)]);
  }
  rows.push(['Alerts', check.alertAfterFailures > 0
    ? `after ${check.alertAfterFailures} failure${check.alertAfterFailures === 1 ? '' : 's'} · ${check.alertSeverity}`
    : 'off']);
  if (check.lastError) rows.push(['Last error', check.lastError]);
  return (
    <div className="ck-detail">
      <dl className="ck-facts">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd className="mono">
              {v}
              {k === 'Ping URL' && (
                <button type="button" className="btn tiny ghost" style={{ marginLeft: 8 }}
                  onClick={() => navigator.clipboard?.writeText(v)}>Copy</button>
              )}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {LATENCY_TYPES.has(check.type) && <StatsRow checkId={check.id} />}
    </div>
  );
}

function CheckRow({ check, spark, isAdmin, open, onToggleOpen, busy, onRun, onPause, onRemove, onAccept }) {
  const st = stateOf(check);
  const kind = KIND[check.type] || { name: check.type, tag: check.type };
  return (
    <div className={`ck-row ${st} ${open ? 'open' : ''}`}>
      <button type="button" className="ck-row-main" onClick={onToggleOpen} aria-expanded={open}>
        <span className={`ck-dot ${st}`} title={STATE_LABEL[st]} />
        <span className="ck-name">
          <span className="ck-kind">{kind.name}<span className="ck-tag">{kind.tag}</span></span>
          <span className="ck-label">{check.label}</span>
        </span>
        <span className="ck-metric"><MetricCell check={check} spark={spark} /></span>
        <span className="ck-sched">
          <span>every {fmtInterval(check.intervalSec)}</span>
          <span className="dim">{st === 'paused' ? 'paused' : relativeTime(check.lastRunAt)}</span>
        </span>
      </button>
      {isAdmin && (
        <div className="ck-actions">
          {check.type === 'dns' && check.trackChanges && check.lastUp === 0 && (
            <button type="button" className="btn tiny" onClick={onAccept} title="Accept the current records as the new baseline">
              Accept change
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onRun} disabled={busy || !check.enabled}
            title="Run now" aria-label="Run now">
            <IconRun className={busy ? 'ck-spin' : ''} />
          </button>
          <button type="button" className="icon-btn" onClick={onPause}
            title={check.enabled ? 'Pause' : 'Resume'} aria-label={check.enabled ? 'Pause' : 'Resume'}>
            {check.enabled ? <IconPause /> : <IconResume />}
          </button>
          <button type="button" className="icon-btn danger" onClick={onRemove} title="Delete" aria-label="Delete">
            <IconTrash />
          </button>
        </div>
      )}
      {open && <DetailPanel check={check} />}
    </div>
  );
}

function Hero({ list }) {
  const active = list.filter((c) => c.enabled);
  const failing = active.filter((c) => c.lastUp === 0);
  const pending = active.filter((c) => c.lastUp == null).length;
  const paused = list.length - active.length;
  const lastRun = Math.max(0, ...list.map((c) => c.lastRunAt || 0));
  const expiring = active
    .filter((c) => typeof c.detail?.daysLeft === 'number')
    .sort((a, b) => a.detail.daysLeft - b.detail.daysLeft)[0];
  const tone = failing.length ? (failing.some((c) => stateOf(c) === 'crit') ? 'crit' : 'warn') : 'ok';
  const headline = failing.length
    ? `${failing.length} of ${active.length} checks failing`
    : active.length ? `All ${active.length} checks passing` : 'No active checks';
  return (
    <div className={`card ck-hero ${tone}`}>
      <div className="ck-hero-main">
        <span className={`ck-hero-dot ${tone}`} />
        <div>
          <div className="ck-hero-title">{headline}</div>
          <div className="ck-hero-sub">
            {failing.length > 0
              ? failing.slice(0, 3).map((c) => c.label).join(' · ') + (failing.length > 3 ? ' …' : '')
              : `Last run ${relativeTime(lastRun || null)}`}
            {pending > 0 && ` · ${pending} pending`}
            {paused > 0 && ` · ${paused} paused`}
          </div>
        </div>
      </div>
      {expiring && (
        <div className="ck-hero-side">
          <div className="ck-hero-k">Soonest expiry</div>
          <div className="ck-hero-v">
            <strong>{expiring.detail.daysLeft} days</strong>
            <span className="dim"> · {expiring.label}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Checks() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useLocalSetting('othoni.checks.filter', 'all');
  const [sparks, setSparks] = useState({}); // id -> [{t, v}]

  function refresh() {
    api.checks.list().then((r) => setList(r.checks || [])).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  // Latency sparklines (last hour) for website / port / ping checks.
  const latencyIds = useMemo(
    () => (list || []).filter((c) => LATENCY_TYPES.has(c.type)).map((c) => c.id).join(','),
    [list],
  );
  useEffect(() => {
    if (!latencyIds) return undefined;
    let alive = true;
    const load = () => Promise.all(latencyIds.split(',').map((id) =>
      api.history(`check.${id}.latency_ms`, '1h')
        .then((r) => [id, r.points || []])
        .catch(() => [id, []]),
    )).then((pairs) => { if (alive) setSparks(Object.fromEntries(pairs)); });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [latencyIds]);

  async function act(fn) {
    try { await fn(); refresh(); }
    catch (e) { setErr(e.body?.message || e.message); }
  }
  const togglePause = (c) => act(() => api.checks.update(c.id, { enabled: !c.enabled }));
  const remove = (c) => confirm(`Delete check "${c.label}"?`) && act(() => api.checks.remove(c.id));
  const acceptDns = (c) => act(async () => {
    await api.checks.update(c.id, { resetBaseline: true });
    await api.checks.runNow(c.id);
  });
  async function runNow(c) {
    setRunning(c.id);
    await act(() => api.checks.runNow(c.id));
    setRunning(null);
  }

  const counts = useMemo(() => {
    const out = {};
    for (const f of FILTERS) out[f.key] = (list || []).filter(f.match).length;
    return out;
  }, [list]);

  const groups = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) || FILTERS[0];
    const map = new Map();
    for (const c of (list || []).filter(f.match)) {
      const k = groupKey(c);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    }
    const arr = [...map.entries()].map(([name, items]) => {
      items.sort((a, b) => (STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)])
        || (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)));
      const failing = items.filter((c) => c.enabled && c.lastUp === 0).length;
      return { name, items, failing };
    });
    // Failing groups first, then hosts alphabetically, then the special groups.
    const special = (n) => (n === 'Domain registrations' || n === 'Heartbeats' ? 1 : 0);
    arr.sort((a, b) => (b.failing > 0) - (a.failing > 0) || special(a.name) - special(b.name) || a.name.localeCompare(b.name));
    return arr;
  }, [list, filter]);

  return (
    <div className="page-fade-in">
      <div className="ck-head">
        <div>
          <h1 className="page-title">Checks</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Uptime, certificates, DNS and heartbeats for everything this box serves.
          </p>
        </div>
        {isAdmin && !adding && (
          <button type="button" className="btn compact" onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconPlus /> Add check
          </button>
        )}
      </div>

      {err && <div className="error">{err}</div>}
      {adding && <AddCheckForm onCreated={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />}

      {list == null && (
        <div className="ck-skeleton">
          <div className="card skeleton" style={{ height: 76 }} />
          <div className="card skeleton" style={{ height: 180 }} />
          <div className="card skeleton" style={{ height: 180 }} />
        </div>
      )}

      {list != null && list.length === 0 && !adding && (
        <div className="card empty" style={{ padding: 32 }}>
          No checks yet. Add one to watch a website, certificate, DNS record, domain registration, or cron job.
        </div>
      )}

      {list != null && list.length > 0 && (
        <>
          <Hero list={list} />

          <div className="ck-filters" role="tablist">
            {FILTERS.filter((f) => f.key === 'all' || f.key === 'failing' || counts[f.key] > 0).map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                className={`ck-filter ${filter === f.key ? 'active' : ''} ${f.key === 'failing' && counts.failing ? 'alert' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}<span className="ck-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>

          {groups.length === 0 && (
            <div className="card empty" style={{ padding: 24 }}>
              {filter === 'failing' ? 'Nothing failing right now.' : 'No checks match this filter.'}
            </div>
          )}

          <div className="ck-groups">
            {groups.map((g) => (
              <section key={g.name} className="card ck-group">
                <header className="ck-group-head">
                  <h2>{g.name}</h2>
                  <span className={`ck-group-state ${g.failing ? 'crit' : 'ok'}`}>
                    {g.failing ? `${g.failing} failing` : `${g.items.length} passing`}
                  </span>
                </header>
                <div className="ck-rows">
                  {g.items.map((c) => (
                    <CheckRow
                      key={c.id}
                      check={c}
                      spark={sparks[c.id]}
                      isAdmin={isAdmin}
                      open={expanded === c.id}
                      onToggleOpen={() => setExpanded(expanded === c.id ? null : c.id)}
                      busy={running === c.id}
                      onRun={() => runNow(c)}
                      onPause={() => togglePause(c)}
                      onRemove={() => remove(c)}
                      onAccept={() => acceptDns(c)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
