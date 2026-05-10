import React, { useState } from 'react';
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

export default function Processes() {
  const { refreshMs } = useApp();
  const [sortBy, setSortBy] = useState('cpu');
  const { data, loading, error } = usePoller(
    () => api.processes(sortBy, 20),
    refreshMs,
    [sortBy]
  );

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Processes</h1>
      <p className="subtitle">Top 20 processes, sorted by {sortBy}.</p>

      <div className="toolbar">
        <button
          className={`btn ghost ${sortBy === 'cpu' ? 'active' : ''}`}
          onClick={() => setSortBy('cpu')}
        >
          By CPU
        </button>
        <button
          className={`btn ghost ${sortBy === 'memory' ? 'active' : ''}`}
          onClick={() => setSortBy('memory')}
        >
          By memory
        </button>
      </div>

      <TrendsCard sortBy={sortBy} />

      {loading && !data && <div className="loading">Loading…</div>}
      {error && !data && <div className="error">Could not load process list.</div>}

      {data?.processes && (
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
