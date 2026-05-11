import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Sparkline } from '../Charts.jsx';
import { formatBytes, formatRate, statusClass } from '../utils.js';

// Map host-metric leaf names to { label, format, range max for the
// sparkline if appropriate, status-from-percent }. Tile order is the
// order of this list.
const METRIC_TILES = [
  { key: 'cpu',       label: 'CPU',        unit: '%',   max: 100, fmt: (v) => `${v.toFixed(1)}%`, statusFromPct: true },
  { key: 'mem',       label: 'Memory',     unit: '%',   max: 100, fmt: (v) => `${v.toFixed(1)}%`, statusFromPct: true },
  { key: 'load1',     label: 'Load (1m)',  unit: '',    max: null, fmt: (v) => v.toFixed(2) },
  { key: 'disk_root', label: 'Root disk',  unit: '%',   max: 100, fmt: (v) => `${v.toFixed(1)}%`, statusFromPct: true },
  { key: 'net_rx',    label: 'Net in',     unit: 'B/s', max: null, fmt: formatRate },
  { key: 'net_tx',    label: 'Net out',    unit: 'B/s', max: null, fmt: formatRate },
];

function freshnessClass(lastSeenAt) {
  const age = Date.now() - lastSeenAt;
  if (age < 60_000) return 'ok';        // green: < 1 min
  if (age < 5 * 60_000) return 'warn';   // amber: < 5 min
  return 'crit';                          // red:   stale
}

function freshnessLabel(lastSeenAt) {
  const age = Date.now() - lastSeenAt;
  if (age < 5_000) return 'live';
  if (age < 60_000) return `${Math.round(age / 1000)}s ago`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}h ago`;
  return `${Math.round(age / 86_400_000)}d ago`;
}

// Per-tile sparkline: fetches 15m of history for this host's leaf metric.
function TileSparkline({ metric, max }) {
  const [points, setPoints] = useState(null);
  useEffect(() => {
    let cancel = false;
    api.history(metric, '15m')
      .then((r) => { if (!cancel) setPoints(r.points || []); })
      .catch(() => { if (!cancel) setPoints([]); });
    return () => { cancel = true; };
  }, [metric]);
  if (!points || points.length === 0) {
    return <div style={{ height: 28, opacity: 0.3 }} />;
  }
  return (
    <Sparkline
      points={points}
      width={120}
      height={28}
      fixedMax={max != null ? max : undefined}
      stroke="var(--accent)"
    />
  );
}

function HostTile({ leaf, value, metricName, meta }) {
  const cls = meta.statusFromPct && value != null ? statusClass(value) : '';
  return (
    <div className="stat-tile" style={{ padding: '10px 12px' }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{meta.label}</div>
      <div
        className={`mono ${cls}`}
        style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}
      >
        {value != null ? meta.fmt(value) : '—'}
      </div>
      {metricName && <TileSparkline metric={metricName} max={meta.max} />}
    </div>
  );
}

function HostCard({ host }) {
  const freshness = freshnessClass(host.lastSeenAt);
  const extras = Object.entries(host.extras || {});
  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`chip ${freshness}`} style={{ fontSize: 11 }}>
              <span className="dot" />{freshnessLabel(host.lastSeenAt)}
            </span>
            <span className="mono" style={{ fontSize: 16 }}>{host.host}</span>
          </div>
          <div className="card-sub" style={{ fontSize: 11 }}>
            Pushing via <code>POST /api/metrics</code> · last sample{' '}
            {new Date(host.lastSeenAt).toLocaleString([], { hour12: false })}
          </div>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginTop: 12, gap: 10 }}>
        {METRIC_TILES.map((meta) => {
          const entry = host.metrics[meta.key];
          return (
            <HostTile
              key={meta.key}
              leaf={meta.key}
              value={entry ? entry.v : null}
              metricName={entry ? entry.metric : null}
              meta={meta}
            />
          );
        })}
      </div>

      {extras.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 16, marginBottom: 6 }}>
            Other custom metrics
          </div>
          <div className="grid cols-3" style={{ gap: 10 }}>
            {extras.map(([leaf, entry]) => (
              <div className="stat-tile" key={leaf} style={{ padding: '10px 12px' }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{leaf}</div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                  {entry.v.toFixed(2)}
                </div>
                <TileSparkline metric={entry.metric} max={null} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Hosts() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  function refresh() {
    api.hosts()
      .then((r) => setData(r.hosts || []))
      .catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    // 10s refresh — the agents typically push every 30s so faster than
    // that is wasted; slower than that adds visible lag for "did I see
    // my last push land?"
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Hosts</h1>
      <p className="subtitle">
        Remote hosts pushing metrics via <code>POST /api/metrics</code> with the
        v0.23.0 <code>host</code> attribution. Auto-discovered from{' '}
        <code>custom.&lt;host&gt;.*</code> series in the history store.
      </p>

      {err && <div className="error">{err}</div>}

      {data && data.length === 0 && (
        <div className="card">
          <div className="card-header">
            <div className="card-title">No hosts yet</div>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            No <code>custom.&lt;host&gt;.*</code> metrics have arrived in the
            last 10 minutes. To start pushing:
          </p>
          <ol className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
            <li>
              On <strong>Settings</strong>, generate an API key (label
              it with the remote host's name).
            </li>
            <li>
              Copy <code>agent.sh</code> from the repo onto the remote
              host. The README's "Bundled <code>agent.sh</code>" section
              walks through the systemd setup.
            </li>
            <li>
              Run with <code>OTHONI_URL</code> + <code>OTHONI_API_KEY</code>{' '}
              + <code>OTHONI_HOST</code> set. The host name must match{' '}
              <code>[a-z0-9-]&#123;1,40&#125;</code>.
            </li>
          </ol>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="grid cols-2" style={{ gap: 16 }}>
          {data.map((h) => <HostCard key={h.host} host={h} />)}
        </div>
      )}
    </div>
  );
}
