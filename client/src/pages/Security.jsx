import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App.jsx';

const SEV_LABEL = { crit: 'Critical', warn: 'Warning', info: 'Info', ok: 'OK' };
const SEV_ORDER = ['crit', 'warn', 'info', 'ok'];

function relativeTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

function SeverityChip({ severity }) {
  const klass = severity === 'ok' ? 'ok'
    : severity === 'warn' ? 'warn'
    : severity === 'crit' ? 'crit'
    : 'dim';
  return (
    <span className={`pill ${klass}`} style={{ fontSize: 10 }}>
      {SEV_LABEL[severity] || severity}
    </span>
  );
}

function Finding({ f }) {
  const accentBar = {
    crit: 'var(--crit)',
    warn: 'var(--warn)',
    info: 'var(--text-dim)',
    ok:   'var(--ok)',
  }[f.severity] || 'var(--text-dim)';
  return (
    <div
      className="card"
      style={{
        padding: '14px 16px',
        borderLeft: `3px solid ${accentBar}`,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <SeverityChip severity={f.severity} />
            <div style={{ fontWeight: 600, fontSize: 14 }}>{f.title}</div>
          </div>
          {f.detail && (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
              {f.detail}
            </div>
          )}
          {f.evidence && (
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                marginTop: 8,
                padding: '6px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-xs)',
                color: 'var(--text-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {f.evidence}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Security() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState(null); // null = all, or severity key

  function load({ force = false } = {}) {
    if (force) setRunning(true);
    api.securityAudit({ force })
      .then((r) => { setData(r); setErr(null); })
      .catch((e) => setErr(e.body?.message || e.message))
      .finally(() => { setLoading(false); setRunning(false); });
  }

  useEffect(() => {
    load();
    // Audits don't change rapidly — refresh once a minute to align with
    // server-side cache TTL. The "Re-run" button does a forced refresh.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const findings = data?.findings || [];
  const filtered = filter ? findings.filter((f) => f.severity === filter) : findings;
  const summary = data?.summary || { crit: 0, warn: 0, info: 0, ok: 0, total: 0 };

  // Group filtered findings by category for the sectioned render.
  const byCategory = {};
  for (const f of filtered) {
    (byCategory[f.category] = byCategory[f.category] || []).push(f);
  }
  // Sort categories by their worst severity so the most-actionable
  // group is at the top of the page.
  const categories = Object.keys(byCategory).sort((a, b) => {
    const worst = (list) => Math.min(...list.map((f) => SEV_ORDER.indexOf(f.severity)));
    return worst(byCategory[a]) - worst(byCategory[b]);
  });

  // Overall "score" — quick at-a-glance health based on the worst
  // finding. Critical takes precedence; otherwise warnings; otherwise ok.
  const score = summary.crit > 0 ? 'crit' : summary.warn > 0 ? 'warn' : 'ok';
  const scoreLabel = score === 'crit' ? 'Attention needed'
    : score === 'warn' ? 'Mostly clean'
    : 'No issues found';

  if (loading && !data) return <div className="loading">Running audit…</div>;

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Security audit</h1>
      <p className="subtitle">
        Read-only checks across the VPS surface: open ports, SSH configuration,
        firewall state, OS updates, and authentication. Nothing here writes,
        scans, or probes — all checks read local state.
      </p>

      {err && <div className="error">{err}</div>}

      {/* Summary header — score + count tiles + Re-run */}
      <div
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 16,
          padding: 16,
          marginBottom: 16,
          borderColor: score === 'crit' ? 'var(--crit)' : score === 'warn' ? 'var(--warn)' : 'var(--ok)',
        }}
      >
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Overall
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              marginTop: 2,
              color: score === 'crit' ? 'var(--crit)' : score === 'warn' ? 'var(--warn)' : 'var(--ok)',
            }}
          >
            {scoreLabel}
          </div>
          {data && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Audited {relativeTime(data.ranAt)} · took {data.durationMs}ms
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto', alignItems: 'center' }}>
          {SEV_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn ghost${filter === s ? ' active' : ''}`}
              onClick={() => setFilter(filter === s ? null : s)}
              style={{ padding: '6px 12px', minWidth: 80 }}
              aria-pressed={filter === s}
            >
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                marginRight: 7, verticalAlign: 'middle',
                background: s === 'crit' ? 'var(--crit)' : s === 'warn' ? 'var(--warn)' : s === 'ok' ? 'var(--ok)' : 'var(--text-dim)',
              }} />
              {summary[s] || 0} {SEV_LABEL[s]}
            </button>
          ))}
          {isAdmin && (
            <button
              type="button"
              className="btn compact"
              onClick={() => load({ force: true })}
              disabled={running}
              style={{ marginLeft: 8 }}
            >
              {running ? 'Re-running…' : '↻ Re-run audit'}
            </button>
          )}
        </div>
      </div>

      {filter && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Filtered to <strong>{SEV_LABEL[filter]}</strong> only ({filtered.length} of {findings.length}).{' '}
          <button type="button" className="btn ghost" onClick={() => setFilter(null)} style={{ padding: '2px 8px', fontSize: 11 }}>
            Clear filter
          </button>
        </div>
      )}

      {/* Findings grouped by category */}
      {filtered.length === 0 && (
        <div className="card empty" style={{ padding: 32 }}>
          {filter ? 'No findings at this severity.' : 'No findings — every check passed.'}
        </div>
      )}
      {categories.map((cat) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div className="section-title">
            {cat}
            <span className="dim" style={{ fontSize: 11 }}>
              {byCategory[cat].length} finding{byCategory[cat].length === 1 ? '' : 's'}
            </span>
          </div>
          {byCategory[cat].map((f) => <Finding key={f.id} f={f} />)}
        </div>
      ))}
    </div>
  );
}
