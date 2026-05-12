import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { Sparkline, LineChart } from '../Charts.jsx';
import { formatRate, statusClass } from '../utils.js';

// Mirror the metric set on the /hosts page. Order = tile order on the
// grid; only the agent.sh leaves render here. Any other custom metrics
// the host pushes show up in the Extras section below.
const METRIC_TILES = [
  { key: 'cpu',       label: 'CPU',        unit: '%',   max: 100, fmt: (v) => `${v.toFixed(1)}%`, statusFromPct: true },
  { key: 'mem',       label: 'Memory',     unit: '%',   max: 100, fmt: (v) => `${v.toFixed(1)}%`, statusFromPct: true },
  { key: 'load1',     label: 'Load (1m)',  unit: '',    max: null, fmt: (v) => v.toFixed(2) },
  { key: 'disk_root', label: 'Root disk',  unit: '%',   max: 100, fmt: (v) => `${v.toFixed(1)}%`, statusFromPct: true },
  { key: 'net_rx',    label: 'Net in',     unit: 'B/s', max: null, fmt: formatRate },
  { key: 'net_tx',    label: 'Net out',    unit: 'B/s', max: null, fmt: formatRate },
];

function relativeTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function HostHeroChart({ metric, range }) {
  const [points, setPoints] = useState(null);
  useEffect(() => {
    let cancel = false;
    api.history(metric, range)
      .then((r) => { if (!cancel) setPoints(r.points || []); })
      .catch(() => { if (!cancel) setPoints([]); });
    return () => { cancel = true; };
  }, [metric, range]);
  if (!points) return <div className="loading">Loading chart…</div>;
  if (points.length === 0) {
    return <div className="empty" style={{ padding: '32px 0', fontSize: 13 }}>No samples for {metric} in this range.</div>;
  }
  return (
    <LineChart
      points={points}
      height={180}
      stroke="var(--accent)"
      fill="var(--accent-soft)"
      enableBrush={true}
    />
  );
}

function TileSparkline({ metric, max, range }) {
  const [points, setPoints] = useState(null);
  useEffect(() => {
    let cancel = false;
    api.history(metric, range)
      .then((r) => { if (!cancel) setPoints(r.points || []); })
      .catch(() => { if (!cancel) setPoints([]); });
    return () => { cancel = true; };
  }, [metric, range]);
  if (!points || points.length === 0) {
    return <div style={{ height: 32, opacity: 0.3 }} />;
  }
  return (
    <Sparkline
      points={points}
      width={180}
      height={32}
      fixedMax={max != null ? max : undefined}
      stroke="var(--accent)"
    />
  );
}

function MetricTile({ leaf, value, metricName, meta, range }) {
  const cls = meta.statusFromPct && value != null ? statusClass(value) : '';
  return (
    <div className="stat-tile" style={{ padding: '12px 14px' }}>
      <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{meta.label}</div>
      <div className={`mono ${cls}`} style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
        {value != null ? meta.fmt(value) : '—'}
      </div>
      {metricName && <TileSparkline metric={metricName} max={meta.max} range={range} />}
    </div>
  );
}

const RANGES = [
  { value: '15m', label: '15m' },
  { value: '1h',  label: '1h'  },
  { value: '6h',  label: '6h'  },
  { value: '24h', label: '24h' },
];

const HERO_METRICS = [
  { value: 'cpu',       label: 'CPU' },
  { value: 'mem',       label: 'Memory' },
  { value: 'load1',     label: 'Load (1m)' },
  { value: 'disk_root', label: 'Root disk' },
  { value: 'net_rx',    label: 'Net in' },
  { value: 'net_tx',    label: 'Net out' },
];

export default function HostDetail() {
  const { host } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [range, setRange] = useState('1h');
  const [heroKey, setHeroKey] = useState('cpu');

  function refresh() {
    api.hostDetail(host)
      .then((r) => { setData(r.host); setErr(null); })
      .catch((e) => { setErr(e.body?.error === 'not_found' ? 'not_found' : e.message); });
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [host]);

  if (err === 'not_found') {
    return (
      <div className="page-fade-in">
        <h1 className="page-title">Host: {host}</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No samples, metadata, or alert history exist for{' '}
            <span className="mono">{host}</span>.
          </p>
          <p className="dim" style={{ marginTop: 12, fontSize: 13 }}>
            Either the host has never pushed metrics under this name, or
            its 24h sample window has fully rolled off and it carries
            no metadata. <Link to="/hosts">Back to Hosts</Link>.
          </p>
        </div>
      </div>
    );
  }
  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="loading">Loading host…</div>;

  const m = data.meta || {};
  const heroMetricName = data.metrics[heroKey]?.metric || `custom.${host}.${heroKey}`;
  const heroLabel = HERO_METRICS.find((h) => h.value === heroKey)?.label || heroKey;

  return (
    <div className="page-fade-in">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          <Link to="/hosts" className="dim" style={{ textDecoration: 'none' }}>Hosts</Link>
          {' / '}
          <span className="mono">{data.host}</span>
        </h1>
        {!data.live && (
          <span className="chip crit" style={{ fontSize: 11 }}>
            <span className="dot" />no samples in last 10 min
          </span>
        )}
        {data.live && data.lastSeenAt && (
          <span className="chip ok" style={{ fontSize: 11 }}>
            <span className="dot" />last sample {relativeTime(data.lastSeenAt)}
          </span>
        )}
        {m.environment && <span className="chip" style={{ fontSize: 11 }}>{m.environment}</span>}
        {m.owner && <span className="dim" style={{ fontSize: 12 }}>owner: {m.owner}</span>}
        {Array.isArray(m.tags) && m.tags.map((t) => (
          <span key={t} className="chip dim" style={{ fontSize: 10 }}>{t}</span>
        ))}
      </div>
      {m.notes && (
        <p className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 4 }}>{m.notes}</p>
      )}

      <div className="spacer-md" />

      <div className="card">
        <div className="card-header" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="card-title">{heroLabel}</div>
            <div className="card-sub" style={{ fontSize: 12 }}>
              Drag to zoom; double-click to reset.
            </div>
          </div>
          <div className="toolbar" style={{ margin: 0, gap: 4 }}>
            <select
              value={heroKey}
              onChange={(e) => setHeroKey(e.target.value)}
              className="select"
            >
              {HERO_METRICS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                className={`btn ghost ${range === r.value ? 'active' : ''}`}
                onClick={() => setRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <HostHeroChart metric={heroMetricName} range={range} />
        </div>
      </div>

      <div className="spacer-md" />

      <div className="grid cols-3" style={{ gap: 12 }}>
        {METRIC_TILES.map((meta) => {
          const entry = data.metrics[meta.key];
          return (
            <MetricTile
              key={meta.key}
              leaf={meta.key}
              value={entry ? entry.v : null}
              metricName={entry ? entry.metric : null}
              meta={meta}
              range={range}
            />
          );
        })}
      </div>

      {Object.keys(data.extras || {}).length > 0 && (
        <>
          <div className="spacer-md" />
          <div className="card">
            <div className="card-header"><div className="card-title">Other custom metrics</div></div>
            <div className="grid cols-3" style={{ gap: 12, marginTop: 12 }}>
              {Object.entries(data.extras).map(([leaf, entry]) => (
                <div className="stat-tile" key={leaf}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{leaf}</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                    {entry.v.toFixed(2)}
                  </div>
                  <TileSparkline metric={entry.metric} max={null} range={range} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="spacer-md" />

      <div className="card">
        <div className="card-header"><div className="card-title">Recent fires (24h)</div></div>
        {data.fires.length === 0 ? (
          <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
            No alert rules have fired for this host in the last 24 hours.
          </div>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>When</th>
                  <th>Rule</th>
                  <th>Severity</th>
                  <th>Value · threshold</th>
                  <th>Sustained</th>
                </tr>
              </thead>
              <tbody>
                {data.fires.map((f, i) => (
                  <tr key={`${f.t}-${i}`}>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {relativeTime(f.t)}
                      <div className="dim" style={{ fontSize: 11 }}>
                        {new Date(f.t).toLocaleTimeString([], { hour12: false })}
                      </div>
                    </td>
                    <td>
                      <div>{f.label || <span className="dim">(unnamed)</span>}</div>
                      <div className="dim mono" style={{ fontSize: 11 }}>{f.metric}</div>
                    </td>
                    <td>
                      <span className={`chip ${f.severity === 'crit' ? 'crit' : 'warn'}`}>
                        <span className="dot" />{f.severity}
                      </span>
                    </td>
                    <td className="mono dim" style={{ fontSize: 12 }}>
                      {f.value != null ? f.value.toFixed(2) : '—'} {f.comparator === 'gt' || f.comparator === 'rate_gt' ? '>' : '<'}{' '}
                      {f.threshold != null ? f.threshold.toFixed(2) : '—'}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {f.sustainedMs >= 60_000 ? `${Math.round(f.sustainedMs / 60_000)}m` : `${Math.round(f.sustainedMs / 1000)}s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
