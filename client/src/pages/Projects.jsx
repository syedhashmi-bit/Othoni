import React, { useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { pillClass } from '../utils';
import { useApp } from '../App.jsx';

// Which controls to show based on current service status.
function availableActions(status) {
  if (status === 'active')   return ['restart', 'stop'];
  if (status === 'inactive') return ['start'];
  if (status === 'failed')   return ['start', 'restart'];
  return [];
}

function ServiceControls({ name, status, onDone }) {
  const { user } = useApp();
  const [phase, setPhase] = useState('idle');   // idle | confirm | running | done
  const [pending, setPending] = useState(null); // action awaiting confirm
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  if (user?.role !== 'admin') return null;

  const actions = availableActions(status);
  if (actions.length === 0) return null;

  async function run() {
    setPhase('running');
    setErr(null);
    try {
      const r = await api.projects.control(name, pending);
      setResult(r);
      setPhase('done');
      if (onDone) onDone();
    } catch (e) {
      setErr(e.body?.message || e.message);
      setPhase('done');
    }
  }

  function request(action) {
    setPending(action);
    setPhase('confirm');
  }

  function dismiss() {
    setPhase('idle');
    setPending(null);
    setResult(null);
    setErr(null);
  }

  if (phase === 'confirm') {
    return (
      <div
        style={{
          marginTop: 10,
          padding: 8,
          background: 'var(--bg-card-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          <code>systemctl {pending} {name}</code>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button type="button" className="btn tiny" onClick={run}>
            Confirm
          </button>
          <button type="button" className="btn ghost" onClick={dismiss}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'running') {
    return (
      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        {pending}ing…
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div style={{ marginTop: 10 }}>
        {err ? (
          <span className="chip crit">
            <span className="dot" />error · {err}
          </span>
        ) : result?.ok ? (
          <span className="chip ok">
            <span className="dot" />{result.action}ed · {result.durationMs}ms
          </span>
        ) : (
          <span className="chip crit">
            <span className="dot" />exit {result?.exitCode} · {result?.stderr?.split('\n')[0] || 'failed'}
          </span>
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={dismiss}
          style={{ marginLeft: 6, padding: '1px 6px', fontSize: 11 }}
        >
          dismiss
        </button>
      </div>
    );
  }

  // idle — show available action buttons
  return (
    <div className="toolbar" style={{ marginTop: 10 }}>
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className="btn tiny"
          onClick={() => request(action)}
        >
          {action === 'start'   && '▶ Start'}
          {action === 'stop'    && '■ Stop'}
          {action === 'restart' && '↻ Restart'}
        </button>
      ))}
    </div>
  );
}

export default function Projects() {
  const { refreshMs } = useApp();
  const [rescanning, setRescanning] = useState(false);
  // Auto-poll uses the cached scan; a manual rescan sets this flag so the
  // next fetch bypasses the server cache and re-reads /var/www for new
  // directories / freshly-installed units. Consumed on the following tick.
  const forceRef = useRef(false);
  const loader = useCallback(() => {
    const force = forceRef.current;
    forceRef.current = false;
    return api.projects.list(force);
  }, []);
  const { data, loading, error, refresh } = usePoller(loader, refreshMs);

  async function rescan() {
    setRescanning(true);
    forceRef.current = true;
    try {
      await refresh();
    } finally {
      forceRef.current = false;
      setRescanning(false);
    }
  }

  if (loading && !data) return <div className="loading">Scanning {'/var/www'}…</div>;
  if (error && !data)   return <div className="error">Could not load projects.</div>;

  const items = data?.projects || [];
  const root  = data?.root || '/var/www';

  return (
    <div className="page-fade-in">
      <div className="card-header" style={{ marginBottom: 4 }}>
        <h1 className="page-title" style={{ margin: 0 }}>Projects</h1>
        <button
          type="button"
          className="btn compact"
          onClick={rescan}
          disabled={rescanning}
        >
          {rescanning ? 'Rescanning…' : '↻ Refresh'}
        </button>
      </div>
      <p className="subtitle">
        Systemd services matching directories under <code>{root}</code>.
      </p>

      {items.length === 0 ? (
        <div className="muted" style={{ marginTop: 24, fontSize: 13 }}>
          No matching systemd services found. Each service must share its name
          with a directory in <code>{root}</code>.
        </div>
      ) : (
        <div className="grid cols-3">
          {items.map((p) => (
            <div className="card" key={p.name}>
              <div className="card-header">
                <div className="card-title">{p.name}</div>
                <span className={`pill ${pillClass(p.status)}`}>{p.status}</span>
              </div>
              <ServiceControls name={p.name} status={p.status} onDone={refresh} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
