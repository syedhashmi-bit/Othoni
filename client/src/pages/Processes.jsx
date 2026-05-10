import React, { useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { useApp } from '../App.jsx';

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
