import React from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { formatBytes, statusClass } from '../utils';
import { useApp } from '../App.jsx';

export default function Storage() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.disks, refreshMs);

  if (loading && !data) return <div className="loading">Loading disks…</div>;
  if (error && !data) return <div className="error">Could not load disk data.</div>;

  const disks = data?.disks || [];

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Storage</h1>
      <p className="subtitle">Mounted filesystems on this server.</p>

      {disks.length === 0 ? (
        <div className="empty">No disks reported.</div>
      ) : (
        <div className="grid cols-3">
          {disks.map((d) => (
            <div className="card" key={d.mount}>
              <div className="card-header">
                <div className="card-title">{d.mount}</div>
                <span className="muted mono">{d.filesystem}</span>
              </div>
              <div className="card-value">{d.usagePercent.toFixed(1)}%</div>
              <div className="card-sub">
                {formatBytes(d.used)} used of {formatBytes(d.size)} ·{' '}
                {formatBytes(d.available)} free
              </div>
              <div className={`bar ${statusClass(d.usagePercent)}`}>
                <div style={{ width: `${Math.min(100, d.usagePercent)}%` }} />
              </div>
              <div className="spacer-sm" />
              <div className="muted mono" style={{ fontSize: 12 }}>
                {d.device}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
