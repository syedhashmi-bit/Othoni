import React, { useEffect, useState } from 'react';
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

// Map container state → which docker actions make sense.
function allowedVerbs(state) {
  const s = (state || '').toLowerCase();
  if (s === 'running') return ['stop', 'restart'];
  if (s === 'paused') return ['restart'];
  if (s === 'restarting') return [];               // wait for it to settle
  // exited / dead / created / "" → can start
  return ['start'];
}

// Per-row state-aware controls. Two-step UX matching the systemd
// version: button → confirm strip → run → result chip.
function DockerControls({ container, canRun, onActed }) {
  const { user } = useApp();
  const [pending, setPending] = useState(null);     // { verb }
  const [running, setRunning] = useState(null);     // verb currently running
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  if (!canRun) return null;
  if (user?.role !== 'admin') return null;

  const verbs = allowedVerbs(container.state);
  if (verbs.length === 0) {
    return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  }

  async function go(verb) {
    setRunning(verb);
    setPending(null);
    setErr(null);
    try {
      const r = await api.actions.run({
        kind: `docker.${verb}`,
        target: container.name || container.id,
      });
      setResult({ verb, ...r.result });
      if (onActed) onActed();
    } catch (e) {
      setErr({ verb, message: e.body?.message || e.message });
    } finally {
      setRunning(null);
    }
  }

  if (running) {
    return <span className="muted" style={{ fontSize: 11 }}>{running}…</span>;
  }

  if (pending) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 11 }}>
          {pending.verb} <code>{container.name || container.id}</code>?
        </span>
        <button type="button" className="btn tiny" onClick={() => go(pending.verb)}>
          confirm
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => setPending(null)}
          style={{ padding: '1px 6px', fontSize: 11 }}
        >
          cancel
        </button>
      </span>
    );
  }

  if (result || err) {
    const isOk = !err && result?.ok;
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className={`chip ${isOk ? 'ok' : 'crit'}`} style={{ fontSize: 11 }}>
          <span className="dot" />
          {err
            ? `${err.verb} failed`
            : isOk
              ? `${result.verb} ok · ${result.durationMs}ms`
              : `${result.verb} exit ${result.exitCode}`}
        </span>
        <button
          type="button"
          className="btn ghost"
          onClick={() => { setResult(null); setErr(null); }}
          style={{ padding: '1px 6px', fontSize: 11 }}
        >
          dismiss
        </button>
        {(err?.message || result?.stderr) && (
          <span className="mono crit" style={{ fontSize: 11 }}>
            {(err?.message || result.stderr).split('\n')[0]}
          </span>
        )}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {verbs.map((v) => (
        <button
          key={v}
          type="button"
          className="btn tiny"
          onClick={() => setPending({ verb: v })}
        >
          {v}
        </button>
      ))}
    </span>
  );
}

export default function Docker() {
  const { refreshMs, user } = useApp();
  const { data, loading, error, refresh } = usePoller(api.docker, refreshMs);

  const [actionsState, setActionsState] = useState(null);
  useEffect(() => {
    api.actions.list()
      .then(setActionsState)
      .catch(() => setActionsState({ enabled: false, kinds: [] }));
  }, []);

  const canRun =
    user?.role === 'admin' &&
    !!actionsState?.enabled &&
    (actionsState.kinds || []).some((k) => k.kind.startsWith('docker.'));

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
            Add the user that runs Othoni to the <span className="mono">docker</span>{' '}
            group, or run Othoni as a user with socket access.
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
        {canRun && (
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            · Actions enabled — start / stop / restart are available per container,
            audit-logged.
          </span>
        )}
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
                  {canRun && <th style={{ width: 220 }}>Actions</th>}
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
                    {canRun && (
                      <td>
                        <DockerControls
                          container={c}
                          canRun={canRun}
                          onActed={refresh}
                        />
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
