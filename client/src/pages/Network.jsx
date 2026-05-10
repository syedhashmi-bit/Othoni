import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { formatBytes, formatRate } from '../utils';
import { useApp } from '../App.jsx';
import { Sparkline } from '../Charts.jsx';

// Last-15-minute trend per interface, refreshed every 30s. Slower than the
// live-counters poll because the sparkline shows ~180 samples either way and
// the visual barely changes from one tick to the next.
function useIfaceTrends(ifaces) {
  const [trends, setTrends] = useState({}); // { name: { rx: [{t,v}], tx: [{t,v}] } }
  const key = ifaces.map((i) => i.name).filter((n) => n !== 'lo' && !/^veth/.test(n)).join('|');
  useEffect(() => {
    if (!key) { setTrends({}); return undefined; }
    let alive = true;
    const names = key.split('|');
    const refresh = async () => {
      try {
        const pairs = await Promise.all(
          names.map(async (n) => {
            const [rx, tx] = await Promise.all([
              api.history(`net.iface.${n}.rx`, '15m').catch(() => ({ points: [] })),
              api.history(`net.iface.${n}.tx`, '15m').catch(() => ({ points: [] })),
            ]);
            return [n, { rx: rx.points || [], tx: tx.points || [] }];
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

export default function Network() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.network, refreshMs);
  const trends = useIfaceTrends(data?.interfaces || []);

  if (loading && !data) return <div className="loading">Loading network…</div>;
  if (error && !data) return <div className="error">Could not read /proc/net/dev.</div>;

  const ifaces = data?.interfaces || [];

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Network</h1>
      <p className="subtitle">
        Live interface throughput, refreshed every {refreshMs / 1000}s.
        Sparklines show the last 15 minutes (refreshed every 30s).
      </p>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
       <div className="table-wrap" style={{ border: 'none' }}>
        <table className="t">
          <thead>
            <tr>
              <th>Interface</th>
              <th style={{ width: 200 }}>RX trend (15m)</th>
              <th style={{ width: 200 }}>TX trend (15m)</th>
              <th>RX bytes</th>
              <th>TX bytes</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {ifaces.map((i) => {
              const t = trends[i.name];
              const rxColor = '#22c55e';
              const txColor = '#5b8cff';
              return (
                <tr key={i.name}>
                  <td className="mono" style={{ verticalAlign: 'top' }}>
                    {i.name}
                    {i.isLoopback && <span className="dim"> (lo)</span>}
                  </td>
                  <td style={{ width: 200, verticalAlign: 'top' }}>
                    {t ? (
                      <div>
                        <Sparkline points={t.rx} height={24} color={rxColor} format="rate" />
                        <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
                          now <span style={{ color: 'var(--text-muted)' }}>{formatRate(i.rxBytesPerSec)}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="dim" style={{ fontSize: 12 }}>{formatRate(i.rxBytesPerSec)}</div>
                    )}
                  </td>
                  <td style={{ width: 200, verticalAlign: 'top' }}>
                    {t ? (
                      <div>
                        <Sparkline points={t.tx} height={24} color={txColor} format="rate" />
                        <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
                          now <span style={{ color: 'var(--text-muted)' }}>{formatRate(i.txBytesPerSec)}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="dim" style={{ fontSize: 12 }}>{formatRate(i.txBytesPerSec)}</div>
                    )}
                  </td>
                  <td>{formatBytes(i.rxBytes)}</td>
                  <td>{formatBytes(i.txBytes)}</td>
                  <td className="muted">
                    {i.rxErrors + i.txErrors > 0
                      ? `rx ${i.rxErrors} / tx ${i.txErrors}`
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
       </div>
      </div>
    </div>
  );
}
