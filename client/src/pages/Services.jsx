import React from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { pillClass } from '../utils';
import { useApp } from '../App.jsx';

export default function Services() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.services, refreshMs);

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
      <p className="subtitle">Common systemd units on this server.</p>

      <div className="grid cols-3">
        {services.map((s) => (
          <div className="card" key={s.name}>
            <div className="card-header">
              <div className="card-title">{s.name}</div>
              <span className={`pill ${pillClass(s.status)}`}>{s.status}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
