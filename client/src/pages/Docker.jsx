import React from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { useApp } from '../App.jsx';

function statePill(state) {
  if (!state) return 'dim';
  const s = state.toLowerCase();
  if (s === 'running') return 'ok';
  if (s === 'exited' || s === 'dead') return 'crit';
  if (s === 'paused' || s === 'restarting') return 'warn';
  return 'dim';
}

export default function Docker() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.docker, refreshMs);

  if (loading && !data) return <div className="loading">Checking Docker…</div>;
  if (error && !data) return <div className="error">Could not query Docker.</div>;

  if (!data.installed) {
    return (
      <div className="page-fade-in">
        <h1 className="page-title">Docker</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {data.message}
          </p>
          <p className="dim" style={{ marginTop: 12, fontSize: 13 }}>
            Install Docker on this VPS and the dashboard will pick it up automatically.
          </p>
        </div>
      </div>
    );
  }

  if (!data.accessible) {
    return (
      <div className="page-fade-in">
        <h1 className="page-title">Docker</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {data.message}
          </p>
          <p className="dim" style={{ marginTop: 12, fontSize: 13 }}>
            Add the user that runs othoni to the <span className="mono">docker</span>{' '}
            group, or run othoni as a user with socket access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Docker</h1>
      <p className="subtitle">
        {data.containers.length} container{data.containers.length === 1 ? '' : 's'} on this host.
      </p>

      {data.containers.length === 0 ? (
        <div className="empty">No containers.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Image</th>
                  <th>State</th>
                  <th>Status</th>
                  <th>Ports</th>
                </tr>
              </thead>
              <tbody>
                {data.containers.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="mono">{c.image}</td>
                    <td>
                      <span className={`pill ${statePill(c.state)}`}>{c.state || '—'}</span>
                    </td>
                    <td className="muted">{c.status}</td>
                    <td className="mono dim">{c.ports || '—'}</td>
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
