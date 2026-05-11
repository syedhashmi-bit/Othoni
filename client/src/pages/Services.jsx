import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { pillClass } from '../utils';
import { useApp } from '../App.jsx';

// Restart button for a single systemd unit. Only renders when:
//   (a) /api/actions reports enabled:true,
//   (b) the unit is in the configured action whitelist,
//   (c) the unit isn't "missing" on this host.
// Two-step UX: click → inline confirm strip with Cancel + Restart →
// running spinner → result chip with stderr surfaced inline on failure.
function RestartControl({ unit, status, allowed }) {
  const [phase, setPhase] = useState('idle'); // idle | confirm | running | done
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  if (!allowed) return null;

  async function run() {
    setPhase('running');
    setErr(null);
    try {
      const r = await api.actions.run({ kind: 'systemd.restart', target: unit });
      setResult(r.result);
      setPhase('done');
    } catch (e) {
      setErr(e.body?.message || e.message);
      setPhase('done');
    }
  }

  if (phase === 'idle') {
    return (
      <button
        type="button"
        className="btn tiny"
        onClick={() => setPhase('confirm')}
        disabled={status === 'missing'}
        style={{ marginTop: 8 }}
      >
        ↻ Restart
      </button>
    );
  }

  if (phase === 'confirm') {
    return (
      <div
        style={{
          marginTop: 8,
          padding: 8,
          background: 'var(--bg-card-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          About to <code>systemctl restart {unit}</code> — audit-logged.
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button type="button" className="btn tiny" onClick={run}>
            Confirm restart
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setPhase('idle')}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'running') {
    return (
      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        restarting…
      </div>
    );
  }

  // phase === 'done'
  return (
    <div style={{ marginTop: 8 }}>
      {err ? (
        <span className="chip crit">
          <span className="dot" />error · {err}
        </span>
      ) : result?.ok ? (
        <span className="chip ok">
          <span className="dot" />restarted · {result.durationMs}ms
        </span>
      ) : (
        <span className="chip crit">
          <span className="dot" />exit {result?.exitCode} · {result?.stderr?.split('\n')[0] || 'failed'}
        </span>
      )}
      <button
        type="button"
        className="btn ghost"
        onClick={() => { setPhase('idle'); setResult(null); setErr(null); }}
        style={{ marginLeft: 6, padding: '1px 6px', fontSize: 11 }}
      >
        dismiss
      </button>
    </div>
  );
}

export default function Services() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.services, refreshMs);

  // Fetch the actions state once on mount. Doesn't change without a
  // server restart so polling is pointless.
  const [actionsState, setActionsState] = useState(null);
  useEffect(() => {
    api.actions.list()
      .then(setActionsState)
      .catch(() => setActionsState({ enabled: false, kinds: [] }));
  }, []);

  const restartKind = (actionsState?.kinds || []).find((k) => k.kind === 'systemd.restart');
  const allowedSet = new Set(restartKind?.allowedTargets || []);
  const canRestart = !!actionsState?.enabled && !!restartKind;

  if (loading && !data) return <div className="loading">Loading services…</div>;
  if (error && !data) return <div className="error">Could not query systemctl.</div>;

  // Hide near-duplicate entries (ssh + sshd, redis + redis-server, etc.) when
  // both report "missing" — keeps the UI tidy without dropping useful info.
  const services = (data?.services || []).filter((s, i, arr) => {
    if (s.status !== 'missing') return true;
    const dupes = arr.filter((x) => x.name.startsWith(s.name) || s.name.startsWith(x.name));
    const anyPresent = dupes.some((d) => d.status !== 'missing');
    return !anyPresent;
  });

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Services</h1>
      <p className="subtitle">
        Common systemd units on this server.
        {canRestart && (
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            · Actions enabled — units on the whitelist can be restarted from
            here, audit-logged.
          </span>
        )}
      </p>

      <div className="grid cols-3">
        {services.map((s) => (
          <div className="card" key={s.name}>
            <div className="card-header">
              <div className="card-title">{s.name}</div>
              <span className={`pill ${pillClass(s.status)}`}>{s.status}</span>
            </div>
            {canRestart && (
              <RestartControl
                unit={s.name}
                status={s.status}
                allowed={allowedSet.has(s.name)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
