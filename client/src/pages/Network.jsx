import React from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { formatBytes, formatRate } from '../utils';
import { useApp } from '../App.jsx';

export default function Network() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.network, refreshMs);

  if (loading && !data) return <div className="loading">Loading network…</div>;
  if (error && !data) return <div className="error">Could not read /proc/net/dev.</div>;

  const ifaces = data?.interfaces || [];

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Network</h1>
      <p className="subtitle">Live interface throughput, refreshed every {refreshMs / 1000}s.</p>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
       <div className="table-wrap" style={{ border: 'none' }}>
        <table className="t">
          <thead>
            <tr>
              <th>Interface</th>
              <th>RX bytes</th>
              <th>TX bytes</th>
              <th>RX speed</th>
              <th>TX speed</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {ifaces.map((i) => (
              <tr key={i.name}>
                <td className="mono">
                  {i.name}
                  {i.isLoopback && <span className="dim"> (lo)</span>}
                </td>
                <td>{formatBytes(i.rxBytes)}</td>
                <td>{formatBytes(i.txBytes)}</td>
                <td>{formatRate(i.rxBytesPerSec)}</td>
                <td>{formatRate(i.txBytesPerSec)}</td>
                <td className="muted">
                  {i.rxErrors + i.txErrors > 0
                    ? `rx ${i.rxErrors} / tx ${i.txErrors}`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
       </div>
      </div>
    </div>
  );
}
