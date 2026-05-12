import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { useApp } from '../App.jsx';
import { Sparkline } from '../Charts.jsx';

const RANGES = [
  { value: '15m', label: '15 min' },
  { value: '1h',  label: '1 hour' },
  { value: '6h',  label: '6 hours' },
  { value: '24h', label: '24 hours' },
];

function severityClass(peak) {
  if (peak == null) return '';
  if (peak >= 90) return 'crit';
  if (peak >= 75) return 'warn';
  return '';
}

function severityColor(peak) {
  if (peak == null) return 'var(--accent)';
  if (peak >= 90) return 'var(--crit)';
  if (peak >= 75) return 'var(--warn)';
  return 'var(--accent)';
}

function TrendsCard({ sortBy }) {
  const [range, setRange] = useState('1h');
  // Trend data is sampled every 30s server-side, so polling at 30s is plenty.
  // The live table above polls at refreshMs separately.
  const { data, loading, error } = usePoller(
    () => api.historyProcesses({ range, sortBy, limit: 10 }),
    30000,
    [range, sortBy]
  );

  const unitLabel = sortBy === 'memory' ? 'MEM' : 'CPU';
  const peakField = sortBy === 'memory' ? 'memPeak' : 'cpuPeak';
  const avgField  = sortBy === 'memory' ? 'memAvg'  : 'cpuAvg';

  return (
    <div className="card" style={{ padding: 18, marginBottom: 20 }}>
      <div className="card-header" style={{ marginBottom: 14 }}>
        <div>
          <div className="card-title">Heaviest by {unitLabel.toLowerCase()} · {RANGES.find((r) => r.value === range)?.label}</div>
          <div className="card-sub" style={{ marginTop: 2 }}>
            Top processes ranked by peak {unitLabel.toLowerCase()} %, grouped by name.
            {data?.totalSamples != null && (
              <span className="dim" style={{ marginLeft: 6 }}>
                · {data.totalSamples} snapshot{data.totalSamples === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {RANGES.map((r) => (
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

      {error && <div className="error">Could not load process trends.</div>}
      {loading && !data && <div className="loading">Loading…</div>}

      {data && data.top.length === 0 && !loading && (
        <div className="dim" style={{ fontSize: 13, padding: '24px 0' }}>
          No process samples yet — the trend sampler runs every 30 seconds and
          retains 24 hours. Check back shortly, or change the range.
        </div>
      )}

      {data && data.top.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {data.top.map((p) => {
            const peak = p[peakField];
            const avg  = p[avgField];
            return (
              <div
                key={p.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(140px, 1.4fr) 2fr minmax(150px, auto)',
                  alignItems: 'center',
                  gap: 14,
                  padding: '8px 4px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    title={p.name}
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {p.name}
                  </div>
                  <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
                    seen in {p.samples} snapshot{p.samples === 1 ? '' : 's'}
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <Sparkline
                    points={p.points || []}
                    height={32}
                    color={severityColor(peak)}
                    fixedMax={sortBy === 'memory' ? 100 : undefined}
                    format="percent"
                  />
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className={`mono ${severityClass(peak)}`} style={{ fontSize: 14, fontWeight: 600 }}>
                    {peak != null ? peak.toFixed(1) : '—'}%
                    <span className="dim" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>peak</span>
                  </div>
                  <div className="dim mono" style={{ fontSize: 11, marginTop: 2 }}>
                    avg {avg != null ? avg.toFixed(1) : '—'}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Per-row TERM / KILL controls for the processes table. TERM ("signal")
// is a one-click → confirm-strip flow. KILL ("force kill") requires the
// operator to retype the process name into a text field before the
// confirm button enables — irreversible-destructive operations should
// be deliberate. Both audit-log via the v0.34.0 process.signal kind.
function SignalControl({ proc, canRun, onActed }) {
  const { user } = useApp();
  const [phase, setPhase] = useState('idle'); // idle | confirm-term | confirm-kill | running | done
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(null); // 'TERM' | 'KILL'
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  if (!canRun) return null;
  if (user?.role !== 'admin') return null;

  function reset() {
    setPhase('idle');
    setTyped('');
    setResult(null);
    setErr(null);
  }

  async function go(signal) {
    setRunning(signal);
    setPhase('running');
    setErr(null);
    try {
      const r = await api.actions.run({
        kind: 'process.signal',
        target: String(proc.pid),
        params: { signal },
      });
      setResult({ signal, ...r.result });
    } catch (e) {
      setErr({ signal, message: e.body?.message || e.message });
    } finally {
      setRunning(null);
      setPhase('done');
      if (onActed) onActed();
    }
  }

  if (phase === 'running') {
    return <span className="muted" style={{ fontSize: 11 }}>{running}…</span>;
  }

  if (phase === 'done') {
    const isOk = !err && result?.ok;
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className={`chip ${isOk ? 'ok' : 'crit'}`} style={{ fontSize: 11 }}>
          <span className="dot" />
          {err
            ? `${err.signal} failed`
            : isOk
              ? `${result.signal} sent`
              : `${result.signal} exit ${result.exitCode}`}
        </span>
        <button type="button" className="btn ghost" onClick={reset} style={{ padding: '1px 6px', fontSize: 11 }}>
          dismiss
        </button>
        {(err?.message || (!isOk && result?.stderr)) && (
          <span className="mono crit" style={{ fontSize: 11 }}>
            {(err?.message || result.stderr).split('\n')[0]}
          </span>
        )}
      </span>
    );
  }

  if (phase === 'confirm-term') {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 11 }}>
          SIGTERM PID {proc.pid} ({proc.name})?
        </span>
        <button type="button" className="btn tiny" onClick={() => go('TERM')}>
          confirm
        </button>
        <button type="button" className="btn ghost" onClick={reset} style={{ padding: '1px 6px', fontSize: 11 }}>
          cancel
        </button>
      </span>
    );
  }

  if (phase === 'confirm-kill') {
    const armed = typed.trim() === proc.name;
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="crit" style={{ fontSize: 11 }}>
          SIGKILL is irreversible. Type{' '}
          <code style={{ fontSize: 11 }}>{proc.name}</code> to confirm:
        </span>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="input mono"
          style={{ padding: '1px 6px', width: 140, fontSize: 11 }}
          placeholder={proc.name}
          autoFocus
        />
        <button
          type="button"
          className="btn tiny"
          disabled={!armed}
          onClick={() => go('KILL')}
        >
          kill
        </button>
        <button type="button" className="btn ghost" onClick={reset} style={{ padding: '1px 6px', fontSize: 11 }}>
          cancel
        </button>
      </span>
    );
  }

  // idle
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <button
        type="button"
        className="btn tiny"
        onClick={() => setPhase('confirm-term')}
        title="Send SIGTERM (graceful)"
      >
        signal
      </button>
      <button
        type="button"
        className="btn tiny"
        onClick={() => setPhase('confirm-kill')}
        title="Send SIGKILL (irreversible — requires retyping the process name)"
      >
        kill
      </button>
    </span>
  );
}

// v0.46 process tree row. Recursive. Children render only when `expanded`
// is true. Heavy subtrees (aggCpu >= HEAVY_CPU_PCT) get an accent
// background tint to draw the eye. Auto-expanded for the top-level
// roots and any direct child whose aggCpu crosses the threshold.
const HEAVY_CPU_PCT = 20;
function TreeRow({ node, depth = 0, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = node.children && node.children.length > 0;
  const heavy = node.aggCpu >= HEAVY_CPU_PCT;
  return (
    <>
      <tr style={heavy ? { background: 'rgba(91,140,255,0.05)' } : undefined}>
        <td className="mono">{node.pid}</td>
        <td style={{ paddingLeft: 8 + depth * 16 }}>
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              style={{
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                color: 'var(--text-muted)',
                marginRight: 6,
                fontSize: 10,
                padding: 0,
              }}
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span style={{ display: 'inline-block', width: 16 }} />
          )}
          <span style={{ fontWeight: heavy ? 600 : 400 }}>{node.name}</span>
          {hasChildren && (
            <span className="dim" style={{ fontSize: 10, marginLeft: 6 }}>
              ({node.children.length})
            </span>
          )}
        </td>
        <td className="mono">{node.cpu.toFixed(1)}</td>
        <td className="mono" style={heavy ? { color: 'var(--accent)' } : undefined}>
          {node.aggCpu.toFixed(1)}
        </td>
        <td className="mono">{node.memory.toFixed(1)}</td>
        <td className="mono">{node.aggMemory.toFixed(1)}</td>
        <td className="muted" style={{ fontSize: 12 }}>{node.user}</td>
        <td className="cmd" title={node.command} style={{ fontSize: 12 }}>
          {node.command}
        </td>
      </tr>
      {open && hasChildren && node.children.map((c) => (
        <TreeRow
          key={c.pid}
          node={c}
          depth={depth + 1}
          defaultOpen={c.aggCpu >= HEAVY_CPU_PCT && depth < 2}
        />
      ))}
    </>
  );
}

function ProcessTree() {
  const { refreshMs } = useApp();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancel = false;
    function refresh() {
      api.processTree()
        .then((r) => { if (!cancel) setData(r); })
        .catch((e) => { if (!cancel) setErr(e.message); });
    }
    refresh();
    const id = setInterval(refresh, Math.max(refreshMs, 5000));
    return () => { cancel = true; clearInterval(id); };
  }, [refreshMs]);

  if (err && !data) return <div className="error">Could not load process tree.</div>;
  if (!data) return <div className="loading">Loading tree…</div>;
  if (data.error) return <div className="error">{data.message || data.error}</div>;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="table-wrap" style={{ border: 'none' }}>
        <table className="t">
          <thead>
            <tr>
              <th>PID</th>
              <th>Name (subtree)</th>
              <th>self CPU %</th>
              <th>agg CPU %</th>
              <th>self MEM %</th>
              <th>agg MEM %</th>
              <th>User</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {data.roots.map((r) => (
              <TreeRow key={r.pid} node={r} depth={0} defaultOpen={true} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Processes() {
  const { refreshMs } = useApp();
  const [sortBy, setSortBy] = useState('cpu');
  const [view, setView] = useState('list'); // 'list' | 'tree'
  const { data, loading, error, refresh } = usePoller(
    () => api.processes(sortBy, 20),
    refreshMs,
    [sortBy]
  );

  const [actionsState, setActionsState] = useState(null);
  useEffect(() => {
    api.actions.list()
      .then(setActionsState)
      .catch(() => setActionsState({ enabled: false, kinds: [] }));
  }, []);
  const canSignal =
    !!actionsState?.enabled &&
    (actionsState.kinds || []).some((k) => k.kind === 'process.signal');

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Processes</h1>
      <p className="subtitle">
        Top 20 processes, sorted by {sortBy}.
        {canSignal && (
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            · Actions enabled — signal / kill available per row, audit-logged.
            Self-protected: PID 1, the dashboard's own PID, and processes matched
            by <code>OTHONI_PROCESS_GUARD</code> are refused.
          </span>
        )}
      </p>

      <div className="toolbar">
        <button
          className={`btn ghost ${sortBy === 'cpu' ? 'active' : ''}`}
          onClick={() => setSortBy('cpu')}
          disabled={view === 'tree'}
        >
          By CPU
        </button>
        <button
          className={`btn ghost ${sortBy === 'memory' ? 'active' : ''}`}
          onClick={() => setSortBy('memory')}
          disabled={view === 'tree'}
        >
          By memory
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            className={`btn ghost ${view === 'list' ? 'active' : ''}`}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            className={`btn ghost ${view === 'tree' ? 'active' : ''}`}
            onClick={() => setView('tree')}
            title="Parent/child tree with heavy-subtree highlighting"
          >
            Tree
          </button>
        </div>
      </div>

      {view === 'list' && <TrendsCard sortBy={sortBy} />}

      {view === 'tree' && <ProcessTree />}

      {view === 'list' && loading && !data && <div className="loading">Loading…</div>}
      {view === 'list' && error && !data && <div className="error">Could not load process list.</div>}

      {view === 'list' && data?.processes && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Name</th>
                  <th>CPU %</th>
                  <th>MEM %</th>
                  <th>User</th>
                  <th>Command</th>
                  {canSignal && <th style={{ width: 260 }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {data.processes.map((p) => (
                  <tr key={p.pid}>
                    <td className="mono">{p.pid}</td>
                    <td>{p.name}</td>
                    <td>{p.cpu.toFixed(1)}</td>
                    <td>{p.memory.toFixed(1)}</td>
                    <td className="muted">{p.user}</td>
                    <td className="cmd" title={p.command}>
                      {p.command}
                    </td>
                    {canSignal && (
                      <td>
                        <SignalControl proc={p} canRun={canSignal} onActed={refresh} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
