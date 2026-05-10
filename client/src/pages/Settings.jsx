import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App.jsx';
import { IconPlus, IconTrash } from '../Icons.jsx';

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

function ApiKeysCard() {
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
            othoni stores only a hash — you won't see the key again.
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
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td className="mono dim">{k.fingerprint}…</td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatRelative(k.createdAt)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{formatRelative(k.lastUsedAt)}</td>
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
      <p className="subtitle">Configuration for this othoni instance.</p>

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

      <ApiKeysCard />
    </div>
  );
}
