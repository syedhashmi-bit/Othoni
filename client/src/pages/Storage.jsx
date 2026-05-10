import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { formatBytes, formatRate, statusClass } from '../utils';
import { useApp } from '../App.jsx';
import { Sparkline } from '../Charts.jsx';

// Per-device disk I/O trends, refreshed every 30s. Same pattern as the
// per-interface sparklines on the Network page.
function useDiskTrends(devices) {
  const [trends, setTrends] = useState({}); // { name: { read: [{t,v}], write: [{t,v}] } }
  const key = devices.map((d) => d.name).join('|');
  useEffect(() => {
    if (!key) { setTrends({}); return undefined; }
    let alive = true;
    const names = key.split('|');
    const refresh = async () => {
      try {
        const pairs = await Promise.all(
          names.map(async (n) => {
            const [r, w] = await Promise.all([
              api.history(`disk.dev.${n}.read`, '15m').catch(() => ({ points: [] })),
              api.history(`disk.dev.${n}.write`, '15m').catch(() => ({ points: [] })),
            ]);
            return [n, { read: r.points || [], write: w.points || [] }];
          })
        );
        if (!alive) return;
        setTrends(Object.fromEntries(pairs));
      } catch {
        /* keep prior on error */
      }
    };
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
    return () => { alive = false; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return trends;
}

function PerDeviceIOCard({ device, trend }) {
  const r = trend?.read || [];
  const w = trend?.write || [];
  const lastRead  = r.length ? r[r.length - 1].v : null;
  const lastWrite = w.length ? w[w.length - 1].v : null;
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">{device.name}</div>
        <span className="muted mono" style={{ fontSize: 12 }}>{device.type || ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 2 }}>read</div>
          <Sparkline points={r} height={28} color="#5b8cff" format="rate" />
          <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
            {lastRead != null ? formatRate(lastRead) : '—'}
          </div>
        </div>
        <div>
          <div className="dim" style={{ fontSize: 11, marginBottom: 2 }}>write</div>
          <Sparkline points={w} height={28} color="#f59e0b" format="rate" />
          <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
            {lastWrite != null ? formatRate(lastWrite) : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Storage() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.disks, refreshMs);
  // Disk I/O is a separate poll — different shape, lives at /api/diskio.
  const { data: diskio } = usePoller(api.diskio, refreshMs);
  const trends = useDiskTrends(diskio?.devices || []);

  if (loading && !data) return <div className="loading">Loading disks…</div>;
  if (error && !data) return <div className="error">Could not load disk data.</div>;

  const disks = data?.disks || [];
  const devices = diskio?.devices || [];

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Storage</h1>
      <p className="subtitle">Mounted filesystems and per-device disk I/O on this server.</p>

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

      {devices.length > 0 && (
        <>
          <h2 className="section-title">Per-device I/O</h2>
          <p className="subtitle" style={{ marginTop: -8, marginBottom: 12, fontSize: 12 }}>
            Live read/write rates per physical block device. Sparklines show
            the last 15 minutes (refreshed every 30s).
          </p>
          <div className="grid cols-3">
            {devices.map((d) => (
              <PerDeviceIOCard key={d.name} device={d} trend={trends[d.name]} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
