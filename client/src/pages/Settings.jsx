import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp, AdminOnly } from '../App.jsx';
import { IconPlus, IconTrash } from '../Icons.jsx';
import { formatBytes } from '../utils.js';

const REFRESH_OPTIONS = [
  { label: '2 seconds', value: 2000 },
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
  { label: '1 minute', value: 60000 },
];

function formatRelative(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatHours(ms) {
  if (!ms || ms <= 0) return '—';
  const hours = ms / 3_600_000;
  if (hours >= 24) {
    const days = hours / 24;
    return `${days >= 10 ? Math.round(days) : days.toFixed(1)}d`;
  }
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatAbsTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function StorageCard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [stats, setStats] = useState(null);
  const [vac, setVac] = useState(null);
  const [err, setErr] = useState(null);
  const [vacBusy, setVacBusy] = useState(false);

  function refresh() {
    api.dbStats()
      .then(setStats)
      .catch((e) => setErr(e.message));
    api.vacuum.status().then(setVac).catch(() => {});
  }
  useEffect(() => {
    refresh();
    // Cheap query; refresh every 30s so the row counts stay roughly current
    // without thrashing — the sample interval is 5s but the user doesn't
    // need to watch counts tick up live.
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  async function runVacuum() {
    if (!confirm('Run SQLite VACUUM now? Briefly blocks new samples while it runs.')) return;
    setVacBusy(true);
    try {
      await api.vacuum.run();
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setVacBusy(false);
    }
  }

  if (err) {
    return (
      <div className="card">
        <div className="card-header"><div className="card-title">Storage</div></div>
        <div className="error">{err}</div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="card">
        <div className="card-header"><div className="card-title">Storage</div></div>
        <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  const { tables, sizeBreakdown, config, byMetricTop } = stats;
  const maxTopCount = byMetricTop.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  const samplesSpanMs = tables.samples.newestAt && tables.samples.oldestAt
    ? tables.samples.newestAt - tables.samples.oldestAt
    : 0;

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Storage</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            On-disk SQLite history store. Pruned automatically — see the
            <code style={{ marginLeft: 4 }}>OTHONI_RETENTION_MS</code> env var.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="card-value" style={{ fontSize: 24 }}>
            {formatBytes(stats.sizeBytes)}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>total on disk</div>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginTop: 14, gap: 10 }}>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>db</div>
          <div className="mono">{formatBytes(sizeBreakdown.main || 0)}</div>
        </div>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>wal</div>
          <div className="mono">{formatBytes(sizeBreakdown.wal || 0)}</div>
        </div>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>shm</div>
          <div className="mono">{formatBytes(sizeBreakdown.shm || 0)}</div>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginTop: 14, gap: 10 }}>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>sample cadence</div>
          <div className="mono">{Math.round(config.sampleIntervalMs / 1000)}s</div>
        </div>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>process cadence</div>
          <div className="mono">{Math.round(config.processSampleIntervalMs / 1000)}s</div>
        </div>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>retention</div>
          <div className="mono">{formatHours(config.retentionMs)}</div>
        </div>
      </div>

      {vac && (
        <div className="grid cols-3" style={{ marginTop: 10, gap: 10 }}>
          <div className="stat-tile">
            <div className="muted" style={{ fontSize: 11 }}>vacuum scheduled</div>
            <div className="mono">{vac.enabled ? vac.scheduledLocal : 'off'}</div>
          </div>
          <div className="stat-tile">
            <div className="muted" style={{ fontSize: 11 }}>last vacuum</div>
            <div className="mono">{vac.lastRunAt ? formatRelative(vac.lastRunAt) : 'never'}</div>
            {vac.reclaimedBytes != null && (
              <div className="dim" style={{ fontSize: 11 }}>
                {vac.error
                  ? <span className="crit">{vac.error}</span>
                  : `reclaimed ${formatBytes(Math.max(0, vac.reclaimedBytes))}`}
              </div>
            )}
          </div>
          <div className="stat-tile">
            <div className="muted" style={{ fontSize: 11 }}>vacuum</div>
            {isAdmin ? (
              <button
                type="button"
                className="btn tiny"
                onClick={runVacuum}
                disabled={vacBusy || vac.running}
              >
                {vac.running ? 'running…' : vacBusy ? '…' : 'Run now'}
              </button>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>admin only</span>
            )}
          </div>
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 18 }}>
        <table className="t">
          <thead>
            <tr>
              <th>Table</th>
              <th style={{ textAlign: 'right' }}>Rows</th>
              <th>Oldest</th>
              <th>Newest</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">samples</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {tables.samples.count.toLocaleString()}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{formatAbsTime(tables.samples.oldestAt)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{formatAbsTime(tables.samples.newestAt)}</td>
            </tr>
            <tr>
              <td className="mono">process_samples</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {tables.process_samples.count.toLocaleString()}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{formatAbsTime(tables.process_samples.oldestAt)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{formatAbsTime(tables.process_samples.newestAt)}</td>
            </tr>
            <tr>
              <td className="mono">alert_fires</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {tables.alert_fires.count.toLocaleString()}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>{formatAbsTime(tables.alert_fires.oldestAt)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{formatAbsTime(tables.alert_fires.newestAt)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="section-title" style={{ marginTop: 18, marginBottom: 6 }}>
        Top metrics by row count
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {stats.distinctMetrics.toLocaleString()} distinct series total
        {samplesSpanMs ? ` · spanning ${formatHours(samplesSpanMs)}` : ''}.
      </div>
      {byMetricTop.length === 0 ? (
        <div className="empty" style={{ padding: '14px 0', fontSize: 13 }}>
          No samples in the store yet.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ width: '50%' }}></th>
                <th style={{ textAlign: 'right' }}>Rows</th>
              </tr>
            </thead>
            <tbody>
              {byMetricTop.map((r) => (
                <tr key={r.metric}>
                  <td className="mono" style={{ fontSize: 12 }}>{r.metric}</td>
                  <td>
                    <div style={{
                      height: 6,
                      borderRadius: 3,
                      background: 'var(--bg-card-2)',
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.max(2, Math.round((r.count / maxTopCount) * 100))}%`,
                        background: 'var(--accent)',
                        opacity: 0.75,
                      }} />
                    </div>
                  </td>
                  <td className="mono" style={{ textAlign: 'right', fontSize: 12 }}>
                    {r.count.toLocaleString()}
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

const AUDIT_ACTION_LABELS = {
  'login.ok':       { label: 'login ok',      tone: 'ok' },
  'login.fail':     { label: 'login fail',    tone: 'crit' },
  'logout':         { label: 'logout',        tone: 'dim' },
  'apikey.create':  { label: 'apikey create', tone: 'accent' },
  'apikey.revoke':  { label: 'apikey revoke', tone: 'warn' },
  'rules.update':   { label: 'rules update',  tone: 'accent' },
  'webhook.create': { label: 'webhook +',     tone: 'accent' },
  'webhook.update': { label: 'webhook ~',     tone: 'dim' },
  'webhook.delete': { label: 'webhook −',     tone: 'warn' },
  'webhook.test':   { label: 'webhook test',  tone: 'dim' },
  'check.create':   { label: 'check +',       tone: 'accent' },
  'check.update':   { label: 'check ~',       tone: 'dim' },
  'check.delete':   { label: 'check −',       tone: 'warn' },
  'check.run':      { label: 'check run',     tone: 'dim' },
  'session.revoke': { label: 'session revoke',tone: 'warn' },
  'host.meta.update': { label: 'host meta ~', tone: 'accent' },
  'host.meta.delete': { label: 'host meta −', tone: 'warn' },
  'retention.update': { label: 'retention ~', tone: 'accent' },
  'vacuum.run':       { label: 'vacuum',      tone: 'dim' },
};

function AuditLogCard() {
  const [data, setData] = useState(null);
  const [range, setRange] = useState('24h');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState(null);

  function refresh() {
    api.audit({ range, action: filter || null, limit: 200 })
      .then(setData)
      .catch((e) => setErr(e.message));
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range, filter]);

  const events = data?.events || [];
  const counts = data?.counts || [];

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Audit log</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Logins, API key gen/revoke, alert rule edits, webhook + check
            edits. Pruned at the same retention as samples.
          </div>
        </div>
        <button type="button" className="btn tiny" onClick={refresh}>refresh</button>
      </div>

      <div className="toolbar" style={{ marginTop: 12, marginBottom: 8 }}>
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
        <select
          className="select"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginLeft: 'auto', minWidth: 180 }}
        >
          <option value="">all actions</option>
          {Object.keys(AUDIT_ACTION_LABELS).map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {counts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {counts.map((c) => {
            const meta = AUDIT_ACTION_LABELS[c.action];
            return (
              <span
                key={c.action}
                className={`chip ${meta?.tone || ''}`}
                style={{ fontSize: 11, cursor: 'pointer' }}
                onClick={() => setFilter(filter === c.action ? '' : c.action)}
                title={`filter on ${c.action}`}
              >
                {meta?.label || c.action} · {c.n}
              </span>
            );
          })}
        </div>
      )}

      {err && <div className="error">{err}</div>}

      {data && events.length === 0 && (
        <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
          No audit events in this range
          {filter ? ` for "${filter}"` : ''}.
        </div>
      )}

      {events.length > 0 && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 140 }}>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
                <th>IP</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const meta = AUDIT_ACTION_LABELS[e.action] || { label: e.action, tone: 'dim' };
                return (
                  <tr key={`${e.t}-${i}`}>
                    <td className="muted" style={{ fontSize: 12 }}>{formatRelative(e.t)}</td>
                    <td>
                      <span className={`chip ${meta.tone}`} style={{ fontSize: 11 }}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.actor || '—'}</td>
                    <td className="mono dim" style={{ fontSize: 12 }}>{e.target || '—'}</td>
                    <td className="mono dim" style={{ fontSize: 12 }}>{e.ip || '—'}</td>
                    <td className="mono dim" style={{ fontSize: 11 }}>
                      {e.metadata ? JSON.stringify(e.metadata) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActionsCard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  function refresh() {
    api.actions.list()
      .then(setData)
      .catch((e) => setErr(e.message));
  }
  useEffect(() => { refresh(); }, []);

  async function runNoop(dryRun) {
    setTesting(true);
    setErr(null);
    try {
      const r = await api.actions.run({ kind: 'noop', target: '50ms', dryRun });
      setTestResult({ ts: Date.now(), ...r.result });
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Actions</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Opt-in write surface. Service restarts, container start/stop,
            process signals — gated behind <code>OTHONI_ACTIONS_ENABLED</code>{' '}
            in <code>.env</code>. Every invocation is audit-logged.
          </div>
        </div>
        <span className={`chip ${data?.enabled ? 'ok' : ''}`}>
          <span className="dot" />{data?.enabled ? 'enabled' : 'disabled'}
        </span>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      {data && !data.enabled && (
        <div className="empty" style={{ padding: '16px 0', fontSize: 13 }}>
          <p className="muted">
            Set <code>OTHONI_ACTIONS_ENABLED=true</code> in <code>.env</code>{' '}
            and restart the service. Concrete actions (systemd, Docker,
            process signal) land in v0.32 / v0.33 / v0.34.
          </p>
        </div>
      )}

      {data && data.enabled && (
        <>
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Registered kinds ({data.kinds.length})
            </div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Description</th>
                    <th style={{ width: 90 }}>Confirm</th>
                  </tr>
                </thead>
                <tbody>
                  {data.kinds.map((k) => (
                    <tr key={k.kind}>
                      <td className="mono">{k.kind}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{k.description}</td>
                      <td>{k.requiresConfirmation ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <AdminOnly>
            <div style={{ marginTop: 14 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Framework smoke test
              </div>
              <div className="toolbar" style={{ margin: 0 }}>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => runNoop(true)}
                  disabled={testing}
                >
                  Run noop (dry run)
                </button>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => runNoop(false)}
                  disabled={testing}
                >
                  Run noop
                </button>
                {testing && <span className="muted" style={{ fontSize: 12 }}>running…</span>}
              </div>
            {testResult && (
              <div style={{
                marginTop: 10,
                padding: 10,
                background: 'var(--bg-card-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
              }}>
                <div className="mono">
                  ok={String(testResult.ok)} · exit={testResult.exitCode} ·{' '}
                  duration={testResult.durationMs}ms
                  {testResult.dryRun ? ' · dry-run' : ''}
                </div>
                {testResult.stdout && (
                  <div className="mono muted" style={{ marginTop: 4 }}>
                    stdout: {testResult.stdout}
                  </div>
                )}
                {testResult.stderr && (
                  <div className="mono crit" style={{ marginTop: 4 }}>
                    stderr: {testResult.stderr}
                  </div>
                )}
              </div>
            )}
            </div>
          </AdminOnly>
        </>
      )}
    </div>
  );
}

function RetentionCard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState([]); // [{ pattern, ttlMs }]
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  function refresh() {
    api.retention.get()
      .then((r) => {
        setState(r);
        setDraft(r.overrides.slice());
        setDirty(false);
      })
      .catch((e) => setErr(e.message));
  }
  useEffect(() => { refresh(); }, []);

  function update(i, patch) {
    setDraft((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
    setDirty(true);
  }
  function remove(i) {
    setDraft((d) => d.filter((_, idx) => idx !== i));
    setDirty(true);
  }
  function add() {
    setDraft((d) => [...d, { pattern: '', ttlMs: 7 * 24 * 3600 * 1000 }]);
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.retention.set(draft);
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setBusy(false);
    }
  }

  function ttlLabel(ms) {
    if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 86400_000) return `${(ms / 3600_000).toFixed(1)}h`;
    return `${(ms / 86400_000).toFixed(1)}d`;
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Retention overrides</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Per-metric overrides on the global retention default
            (currently <strong>{state ? ttlLabel(state.defaultMs) : '—'}</strong>).
            Patterns are exact names or globs with <code>*</code>.
            Longest matching TTL wins per metric.
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="t">
          <thead>
            <tr>
              <th>Pattern</th>
              <th style={{ width: 140 }}>TTL (ms)</th>
              <th style={{ width: 90 }}>Reads as</th>
              {isAdmin && <th style={{ width: 50 }}></th>}
            </tr>
          </thead>
          <tbody>
            {draft.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 4 : 3} className="muted" style={{ fontSize: 12, padding: '12px 0' }}>
                  No overrides — every metric uses the global default.
                </td>
              </tr>
            )}
            {draft.map((row, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="text"
                    value={row.pattern}
                    onChange={(e) => update(i, { pattern: e.target.value })}
                    placeholder="disk_root or custom.*.disk_root"
                    className="input mono"
                    style={{ fontSize: 12 }}
                    disabled={!isAdmin}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={row.ttlMs}
                    onChange={(e) => update(i, { ttlMs: parseInt(e.target.value, 10) || 0 })}
                    className="input mono"
                    style={{ fontSize: 12 }}
                    disabled={!isAdmin}
                  />
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {Number.isFinite(row.ttlMs) ? ttlLabel(row.ttlMs) : '—'}
                </td>
                {isAdmin && (
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => remove(i)}
                      title="Remove"
                      aria-label="Remove override"
                    >
                      <IconTrash />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn compact"
            onClick={add}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <IconPlus /> Add override
          </button>
          <button
            type="button"
            className="btn compact"
            onClick={save}
            disabled={!dirty || busy}
            style={{ background: dirty ? 'var(--accent)' : 'var(--bg-elevated)', color: dirty ? 'white' : 'var(--text-muted)' }}
          >
            {busy ? 'Saving…' : dirty ? 'Save overrides' : 'Saved'}
          </button>
        </div>
      )}
    </div>
  );
}

function HostsCard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [byHost, setByHost] = useState(null);
  const [hosts, setHosts] = useState([]); // discovered hosts (for the dropdown)
  const [err, setErr] = useState(null);
  const [drafts, setDrafts] = useState({}); // host -> patch
  const [busy, setBusy] = useState(null);

  function refresh() {
    Promise.all([api.hostMeta.list(), api.hosts()])
      .then(([m, h]) => {
        setByHost(m.byHost || {});
        setHosts((h.hosts || []).map((x) => x.host));
      })
      .catch((e) => setErr(e.message));
  }
  useEffect(() => { refresh(); }, []);

  // Union of known + labeled hosts. A host labeled before it ever pushed,
  // or after the agent went silent, still shows up so the operator can
  // see + edit + clear its metadata.
  const allHosts = Array.from(new Set([...(hosts || []), ...Object.keys(byHost || {})])).sort();

  function draftFor(host, field) {
    return drafts[host]?.[field] ?? byHost?.[host]?.[field] ?? (field === 'tags' ? [] : '');
  }
  function setDraft(host, field, value) {
    setDrafts((s) => ({ ...s, [host]: { ...(s[host] || {}), [field]: value } }));
  }

  async function save(host) {
    const patch = drafts[host] || {};
    setBusy(host);
    setErr(null);
    try {
      await api.hostMeta.upsert(host, patch);
      setDrafts((s) => { const c = { ...s }; delete c[host]; return c; });
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setBusy(null);
    }
  }
  async function clearMeta(host) {
    if (!confirm(`Clear metadata for "${host}"?`)) return;
    setBusy(host);
    setErr(null);
    try {
      await api.hostMeta.remove(host);
      setDrafts((s) => { const c = { ...s }; delete c[host]; return c; });
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Hosts</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Optional metadata overlay (owner, environment, tags, notes)
            keyed by host name. Shows up on the Hosts page card and
            filter pills.
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      {byHost != null && allHosts.length === 0 && (
        <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
          No hosts discovered or labeled yet. Push <code>custom.&lt;host&gt;.*</code> samples to populate this list.
        </div>
      )}

      {allHosts.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 140 }}>Host</th>
                <th style={{ width: 140 }}>Owner</th>
                <th style={{ width: 120 }}>Environment</th>
                <th style={{ width: 200 }}>Tags (comma-separated)</th>
                <th>Notes</th>
                {isAdmin && <th style={{ width: 130 }}></th>}
              </tr>
            </thead>
            <tbody>
              {allHosts.map((host) => {
                const cur = byHost[host] || {};
                const draft = drafts[host];
                const dirty = !!draft && Object.keys(draft).length > 0;
                const tagsStr = Array.isArray(draftFor(host, 'tags'))
                  ? draftFor(host, 'tags').join(', ')
                  : '';
                return (
                  <tr key={host}>
                    <td className="mono">{host}</td>
                    <td>
                      <input
                        type="text"
                        value={draftFor(host, 'owner')}
                        onChange={(e) => setDraft(host, 'owner', e.target.value)}
                        className="input"
                        maxLength={80}
                        disabled={!isAdmin}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={draftFor(host, 'environment')}
                        onChange={(e) => setDraft(host, 'environment', e.target.value)}
                        placeholder="prod / staging / dev"
                        className="input"
                        maxLength={40}
                        disabled={!isAdmin}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={tagsStr}
                        onChange={(e) => setDraft(
                          host,
                          'tags',
                          e.target.value.split(',').map((t) => t.trim()).filter(Boolean)
                        )}
                        className="input mono"
                        style={{ fontSize: 12 }}
                        disabled={!isAdmin}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={draftFor(host, 'notes')}
                        onChange={(e) => setDraft(host, 'notes', e.target.value)}
                        className="input"
                        maxLength={2000}
                        disabled={!isAdmin}
                      />
                    </td>
                    {isAdmin && (
                      <td>
                        <button
                          type="button"
                          className="btn tiny"
                          onClick={() => save(host)}
                          disabled={!dirty || busy === host}
                          style={{ marginRight: 6 }}
                        >
                          {busy === host ? '…' : 'Save'}
                        </button>
                        {Object.keys(cur).length > 0 && (
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => clearMeta(host)}
                            disabled={busy === host}
                            style={{ padding: '2px 8px', fontSize: 11 }}
                          >
                            clear
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SessionsCard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null); // sid being revoked

  function refresh() {
    api.sessions.list()
      .then((r) => setList(r.sessions || []))
      .catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    // Refresh every 30s so lastSeen ticks forward.
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  async function revoke(s) {
    const verb = s.self ? 'Revoke YOUR OWN session (this will log you out)' : `Revoke ${s.actor}'s session`;
    if (!confirm(`${verb}?`)) return;
    setBusy(s.sid);
    setErr(null);
    try {
      await api.sessions.revoke(s.sid);
      refresh();
      // Revoking your own session logs you out — let the next API call
      // trigger the unauth flow naturally rather than hard-redirecting.
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setBusy(null);
    }
  }

  const active = (list || []).filter((s) => !s.revokedAt);
  const revoked = (list || []).filter((s) => s.revokedAt);

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Sessions</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Active browser logins. Revoke to invalidate a leaked cookie
            without rotating the JWT secret. Revoked rows stay visible
            for 7 days as a forensic trail.
          </div>
        </div>
        <button type="button" className="btn tiny" onClick={refresh}>refresh</button>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      {list != null && list.length === 0 && (
        <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
          No sessions recorded yet.
        </div>
      )}

      {list != null && list.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Actor</th>
                <th>Role</th>
                <th>IP</th>
                <th>UA</th>
                <th>Started</th>
                <th>Last seen</th>
                <th>Status</th>
                {isAdmin && <th style={{ width: 80 }}></th>}
              </tr>
            </thead>
            <tbody>
              {[...active, ...revoked].map((s) => (
                <tr key={s.sid} style={{ opacity: s.revokedAt ? 0.55 : 1 }}>
                  <td>
                    {s.actor}
                    {s.self && <span className="chip" style={{ marginLeft: 6, fontSize: 10 }}>you</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{s.role}</td>
                  <td className="mono dim" style={{ fontSize: 12 }}>{s.ip || '—'}</td>
                  <td className="mono dim" style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.ua || ''}>
                    {s.ua || '—'}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatRelative(s.createdAt)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatRelative(s.lastSeenAt)}</td>
                  <td>
                    {s.revokedAt ? (
                      <span className="chip dim" style={{ fontSize: 11 }}>
                        <span className="dot" />revoked
                        {s.revokedBy && s.revokedBy !== s.actor && ` by ${s.revokedBy}`}
                      </span>
                    ) : (
                      <span className="chip ok" style={{ fontSize: 11 }}>
                        <span className="dot" />active
                      </span>
                    )}
                  </td>
                  {isAdmin && (
                    <td>
                      {!s.revokedAt && (
                        <button
                          type="button"
                          className="btn tiny"
                          onClick={() => revoke(s)}
                          disabled={busy === s.sid}
                        >
                          {busy === s.sid ? '…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ApiKeysCard() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [keys, setKeys] = useState(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [justCreated, setJustCreated] = useState(null); // { plaintext, label, ... }
  const [copied, setCopied] = useState(false);

  function refresh() {
    api.keys.list()
      .then((r) => setKeys(r.keys || []))
      .catch((e) => setErr(e.message));
  }
  useEffect(() => { refresh(); }, []);

  async function generate(e) {
    e?.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.keys.create(label.trim());
      setJustCreated(r.key);
      setLabel('');
      setCopied(false);
      refresh();
    } catch (e) {
      setErr(e.body?.message || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id, lbl) {
    if (!confirm(`Revoke API key "${lbl}"? This can't be undone.`)) return;
    try {
      await api.keys.revoke(id);
      refresh();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard might be unavailable on http; user can still select+copy */
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">API keys</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Push <code>custom.*</code> metrics into the history store from external agents.
            See <code>POST /api/metrics</code> docs in the README.
          </div>
        </div>
      </div>

      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}

      {justCreated && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
            <strong style={{ color: 'var(--accent)' }}>Copy this now.</strong>{' '}
            Othoni stores only a hash — you won't see the key again.
          </div>
          <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <code style={{ flex: 1, padding: '6px 10px', wordBreak: 'break-all', background: 'var(--bg)', border: '1px solid var(--border)' }}>
              {justCreated.plaintext}
            </code>
            <button
              type="button"
              className="btn tiny"
              onClick={() => copyToClipboard(justCreated.plaintext)}
            >
              {copied ? '✓ copied' : 'copy'}
            </button>
            <button
              type="button"
              className="btn tiny"
              onClick={() => setJustCreated(null)}
              title="Dismiss"
            >
              dismiss
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            label <strong style={{ color: 'var(--text-muted)' }}>{justCreated.label}</strong>
            {' · '}
            fingerprint <span className="mono">{justCreated.fingerprint}</span>
          </div>
        </div>
      )}

      {isAdmin && (
        <form onSubmit={generate} className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
          <input
            type="text"
            placeholder="Label (e.g. app-server-1, cron-job-foo)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            className="input grow"
          />
          <button
            type="submit"
            className="btn compact"
            disabled={busy || !label.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <IconPlus /> Generate
          </button>
        </form>
      )}

      {keys != null && keys.length === 0 && (
        <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
          No keys yet. Generate one above to start pushing metrics.
        </div>
      )}

      {keys != null && keys.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="t">
            <thead>
              <tr>
                <th>Label</th>
                <th>Fingerprint</th>
                <th>Created</th>
                <th>Last used</th>
                {isAdmin && <th style={{ width: 50 }}></th>}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className="mono dim">{k.fingerprint}…</td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatRelative(k.createdAt)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatRelative(k.lastUsedAt)}</td>
                  {isAdmin && (
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => revoke(k.id, k.label)}
                        title="Revoke key"
                        aria-label="Revoke key"
                      >
                        <IconTrash />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { refreshMs, setRefreshMs, density, setDensity, user } = useApp();
  const [server, setServer] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api
      .settings()
      .then(setServer)
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Settings</h1>
      <p className="subtitle">Configuration for this Othoni instance.</p>

      <div className="grid cols-3">
        <div className="card">
          <div className="card-header">
            <div className="card-title">Refresh interval</div>
          </div>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            How often the dashboard polls the server. Saved in your browser only.
          </p>
          <select
            value={refreshMs}
            onChange={(e) => setRefreshMs(Number(e.target.value))}
            className="select"
            style={{ width: '100%' }}
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Density</div>
          </div>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
            Tighter spacing on cards / tables / sections. Useful on dense
            dashboards or smaller screens.
          </p>
          <div className="toolbar" style={{ margin: 0 }}>
            <button
              type="button"
              className={`btn ghost ${density !== 'compact' ? 'active' : ''}`}
              onClick={() => setDensity('comfortable')}
            >
              Comfortable
            </button>
            <button
              type="button"
              className={`btn ghost ${density === 'compact' ? 'active' : ''}`}
              onClick={() => setDensity('compact')}
            >
              Compact
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Session</div>
          </div>
          <dl className="kv">
            <dt>User</dt>
            <dd>{user?.username || '—'}</dd>
            <dt>Hostname</dt>
            <dd>{server?.hostname || '—'}</dd>
            <dt>App version</dt>
            <dd className="mono">{server?.version || '—'}</dd>
          </dl>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Server</div>
          </div>
          {err && <div className="error">{err}</div>}
          <dl className="kv">
            <dt>Listen host</dt>
            <dd className="mono">{server?.host || '—'}</dd>
            <dt>Listen port</dt>
            <dd className="mono">{server?.port || '—'}</dd>
            <dt>NODE_ENV</dt>
            <dd className="mono">{server?.nodeEnv || '—'}</dd>
          </dl>
        </div>
      </div>

      <div className="spacer-md" />

      <StorageCard />

      <div className="spacer-md" />

      <ActionsCard />

      <div className="spacer-md" />

      <HostsCard />

      <div className="spacer-md" />

      <RetentionCard />

      <div className="spacer-md" />

      <SessionsCard />

      <div className="spacer-md" />

      <ApiKeysCard />

      <div className="spacer-md" />

      <AuditLogCard />
    </div>
  );
}
