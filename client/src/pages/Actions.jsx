import React, { useEffect, useState } from 'react';
import { api } from '../api';

const RANGES = ['1h', '6h', '24h'];

const KINDS = [
  '',
  'noop',
  'systemd.restart',
  'docker.start',
  'docker.stop',
  'docker.restart',
  'process.signal',
];

function formatRelative(ms) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function fmtMs(n) {
  if (n == null) return '—';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

// Inline expandable detail row — shows full stdout / stderr + params.
function DetailPanel({ row }) {
  return (
    <div
      style={{
        padding: 14,
        background: 'var(--bg-card-2)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <div className="grid cols-3" style={{ gap: 10, marginBottom: 10 }}>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>kind</div>
          <div className="mono">{row.kind}</div>
        </div>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>target</div>
          <div className="mono">{row.target || '—'}</div>
        </div>
        <div className="stat-tile">
          <div className="muted" style={{ fontSize: 11 }}>actor · ip</div>
          <div className="mono" style={{ fontSize: 12 }}>
            {row.actor || '—'} <span className="dim">·</span> {row.ip || '—'}
          </div>
        </div>
      </div>

      {row.params && Object.keys(row.params).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>params</div>
          <pre
            className="mono"
            style={{
              padding: '6px 10px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 11,
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {JSON.stringify(row.params, null, 2)}
          </pre>
        </div>
      )}

      <div className="grid cols-2" style={{ gap: 10 }}>
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            stdout {row.stdout ? `(${row.stdout.length} bytes)` : '(empty)'}
          </div>
          <pre
            className="mono"
            style={{
              minHeight: 40,
              maxHeight: 200,
              overflow: 'auto',
              padding: '6px 10px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 11,
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {row.stdout || '(empty)'}
          </pre>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            stderr {row.stderr ? `(${row.stderr.length} bytes)` : '(empty)'}
          </div>
          <pre
            className={`mono ${row.stderr ? 'crit' : ''}`}
            style={{
              minHeight: 40,
              maxHeight: 200,
              overflow: 'auto',
              padding: '6px 10px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 11,
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {row.stderr || '(empty)'}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function Actions() {
  const [data, setData] = useState(null);
  const [actors, setActors] = useState([]);
  const [range, setRange] = useState('24h');
  const [kindFilter, setKindFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const [err, setErr] = useState(null);

  function refresh() {
    api.actions
      .history({
        range,
        kind: kindFilter || null,
        actor: actorFilter || null,
        outcome: outcomeFilter || null,
        limit: 200,
      })
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e.message));
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range, kindFilter, actorFilter, outcomeFilter]);
  useEffect(() => {
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [range, kindFilter, actorFilter, outcomeFilter]);

  useEffect(() => {
    api.actions.historyActors({ range })
      .then((r) => setActors(r.actors || []))
      .catch(() => setActors([]));
  }, [range]);

  function toggleRow(idx) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  const events = data?.events || [];
  const counts = data?.counts || [];

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Actions</h1>
      <p className="subtitle">
        Run history of the write surface — systemd restarts, Docker
        controls, process signals. Every invocation is captured with
        full stdout / stderr (up to 8 KB per stream). Pruned at the
        existing 24h retention.
      </p>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        {RANGES.map((r) => (
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
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="">all kinds</option>
          {KINDS.filter(Boolean).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select
          className="select"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
        >
          <option value="">all actors</option>
          {actors.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          className="select"
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
        >
          <option value="">all outcomes</option>
          <option value="ok">ok</option>
          <option value="fail">fail</option>
        </select>
        <button type="button" className="btn tiny" onClick={refresh}>refresh</button>
      </div>

      {counts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {counts.map((c) => (
            <span
              key={c.kind}
              className="chip"
              style={{ fontSize: 11, cursor: 'pointer' }}
              onClick={() => setKindFilter(kindFilter === c.kind ? '' : c.kind)}
              title={`filter on ${c.kind}`}
            >
              {c.kind} · <strong>{c.n}</strong>
              <span className="dim"> · </span>
              <span className="ok">{c.okN}</span>
              <span className="dim"> / </span>
              <span className="crit">{c.failN}</span>
              {c.avgDurationMs != null && (
                <>
                  <span className="dim"> · </span>
                  <span className="mono">{fmtMs(c.avgDurationMs)}</span>
                </>
              )}
            </span>
          ))}
        </div>
      )}

      {err && <div className="error">{err}</div>}

      {data && events.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No action history in this range
            {kindFilter || actorFilter || outcomeFilter ? ' for the current filters' : ''}.
            {' '}Run an action from Services / Docker / Processes to populate.
            Set <code>OTHONI_ACTIONS_ENABLED=true</code> in <code>.env</code> first.
          </p>
        </div>
      )}

      {events.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th>Kind</th>
                  <th>Target</th>
                  <th>Actor</th>
                  <th style={{ width: 70 }}>Outcome</th>
                  <th style={{ width: 90 }}>Duration</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => {
                  const isOpen = expanded.has(i);
                  return (
                    <React.Fragment key={`${e.t}-${i}`}>
                      <tr
                        onClick={() => toggleRow(i)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td className="muted" style={{ fontSize: 12 }}>{formatRelative(e.t)}</td>
                        <td className="mono">{e.kind}</td>
                        <td className="mono dim">{e.target || '—'}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{e.actor || '—'}</td>
                        <td>
                          {e.dryRun ? (
                            <span className="chip" style={{ fontSize: 11 }}>
                              <span className="dot" />dry
                            </span>
                          ) : e.ok ? (
                            <span className="chip ok" style={{ fontSize: 11 }}>
                              <span className="dot" />ok
                            </span>
                          ) : (
                            <span className="chip crit" style={{ fontSize: 11 }}>
                              <span className="dot" />exit {e.exitCode}
                            </span>
                          )}
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{fmtMs(e.durationMs)}</td>
                        <td className="muted">{isOpen ? '▾' : '▸'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <DetailPanel row={e} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
