import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { usePoller, useLocalSetting } from '../hooks';
import { LineChart, MultiLineChart, StackedAreaChart } from '../Charts.jsx';
import { IconPlus, IconTrash } from '../Icons.jsx';

// Catalog of metrics the saved-views picker can pull from. Static set only —
// the per-core / per-iface / per-disk / custom.* variable-cardinality series
// have their own dedicated cards on this page already.
const VIEW_METRICS = [
  // Compute
  { id: 'cpu',         label: 'CPU usage',          format: 'percent', group: 'Compute' },
  { id: 'cpu.user',    label: 'CPU user',           format: 'percent', group: 'Compute' },
  { id: 'cpu.system',  label: 'CPU system',         format: 'percent', group: 'Compute' },
  { id: 'cpu.idle',    label: 'CPU idle',           format: 'percent', group: 'Compute' },
  { id: 'load1',       label: 'Load avg (1m)',      format: 'number',  group: 'Compute' },
  // Memory
  { id: 'mem',         label: 'Memory usage',       format: 'percent', group: 'Memory'  },
  { id: 'swap',        label: 'Swap usage',         format: 'percent', group: 'Memory'  },
  { id: 'mem.active',  label: 'Memory active',      format: 'bytes',   group: 'Memory'  },
  { id: 'mem.cached',  label: 'Memory cached',      format: 'bytes',   group: 'Memory'  },
  { id: 'mem.buffers', label: 'Memory buffers',     format: 'bytes',   group: 'Memory'  },
  { id: 'mem.free',    label: 'Memory free',        format: 'bytes',   group: 'Memory'  },
  // I/O
  { id: 'disk_root',   label: 'Root disk usage',    format: 'percent', group: 'I/O'     },
  { id: 'disk.read',   label: 'Disk read',          format: 'rate',    group: 'I/O'     },
  { id: 'disk.write',  label: 'Disk write',         format: 'rate',    group: 'I/O'     },
  // Network
  { id: 'net_rx',      label: 'Network in',         format: 'rate',    group: 'Network' },
  { id: 'net_tx',      label: 'Network out',        format: 'rate',    group: 'Network' },
  { id: 'conn.established', label: 'Conn established', format: 'number', group: 'Network' },
  { id: 'conn.timewait',    label: 'Conn time-wait',   format: 'number', group: 'Network' },
  { id: 'conn.listening',   label: 'Conn listening',   format: 'number', group: 'Network' },
  { id: 'conn.total',       label: 'Conn total',       format: 'number', group: 'Network' },
];
const METRIC_BY_ID = Object.fromEntries(VIEW_METRICS.map((m) => [m.id, m]));
const VIEW_GROUPS = Array.from(new Set(VIEW_METRICS.map((m) => m.group)));
const VIEWS_KEY = 'othoni.history.views';
const MAX_VIEWS = 8;
const MAX_METRICS_PER_VIEW = 8;
const SERIES_COLORS = [
  '#5b8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7',
  '#06b6d4', '#84cc16', '#ec4899',
];

const RANGES = ['15m', '1h', '6h', '24h'];

function refreshFor(range) {
  return range === '15m' ? 5000 : range === '1h' ? 15000 : 60000;
}

function useMetric(metric, range) {
  const loader = useCallback(() => api.history(metric, range), [metric, range]);
  const { data, error } = usePoller(loader, refreshFor(range), [metric, range]);
  return { points: data?.points || [], error };
}

// Build a CSV from one or more named series and trigger a browser download.
// All series are aligned by the union of their timestamps; missing values
// render as empty fields so the CSV stays valid.
function downloadCsv(filename, series) {
  const tsSet = new Set();
  for (const s of series) for (const p of s.points) tsSet.add(p.t);
  const ts = Array.from(tsSet).sort((a, b) => a - b);
  const indices = series.map((s) => {
    const map = new Map();
    for (const p of s.points) map.set(p.t, p.v);
    return map;
  });
  const header = ['timestamp_iso', ...series.map((s) => s.name)].join(',');
  const lines = [header];
  for (const t of ts) {
    const row = [new Date(t).toISOString()];
    for (let i = 0; i < series.length; i++) {
      const v = indices[i].get(t);
      row.push(v == null ? '' : String(v));
    }
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

function csvFilename(slug, range) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `othoni-${slug}-${range}-${stamp}.csv`;
}

function CsvButton({ slug, range, series }) {
  const total = series.reduce((s, x) => s + (x.points?.length || 0), 0);
  if (!total) return null;
  return (
    <button
      type="button"
      onClick={() => downloadCsv(csvFilename(slug, range), series)}
      title="Download CSV"
      className="btn tiny"
    >
      ↓ csv
    </button>
  );
}

function MetricCard({ title, sub, error, action, children }) {
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">{title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {action}
      </div>
      {error ? <div className="error">Could not load history.</div> : children}
    </div>
  );
}

function SingleChartCard({ metric, title, format, fixedMax, range }) {
  const { points, error } = useMetric(metric, range);
  const latest = points.length ? points[points.length - 1].v : null;
  const sub =
    latest != null
      ? format === 'percent'
        ? `${latest.toFixed(1)}%`
        : format === 'rate'
          ? `${(latest / 1024).toFixed(1)} KB/s`
          : format === 'bytes'
            ? `${(latest / (1024 * 1024)).toFixed(1)} MB`
            : latest.toFixed(2)
      : '—';
  return (
    <MetricCard
      title={title}
      sub={sub}
      error={error}
      action={<CsvButton slug={metric} range={range} series={[{ name: metric, points }]} />}
    >
      <LineChart points={points} height={200} format={format} fixedMax={fixedMax} range={range} enableBrush />
    </MetricCard>
  );
}

function CpuBreakdownCard({ range }) {
  const user = useMetric('cpu.user', range);
  const system = useMetric('cpu.system', range);
  const idle = useMetric('cpu.idle', range);
  const error = user.error || system.error || idle.error;
  const series = [
    { name: 'user', points: user.points, color: '#5b8cff' },
    { name: 'system', points: system.points, color: '#ef4444' },
    { name: 'idle', points: idle.points, color: '#374151' },
  ];
  return (
    <MetricCard
      title="CPU breakdown"
      sub="user / system / idle"
      error={error}
      action={<CsvButton slug="cpu-breakdown" range={range} series={series} />}
    >
      <StackedAreaChart series={series} height={200} format="percent" fixedMax={100} range={range} enableBrush />
    </MetricCard>
  );
}

function MemoryBreakdownCard({ range }) {
  const active = useMetric('mem.active', range);
  const cached = useMetric('mem.cached', range);
  const buffers = useMetric('mem.buffers', range);
  const free = useMetric('mem.free', range);
  const error = active.error || cached.error || buffers.error || free.error;
  const series = [
    { name: 'active', points: active.points, color: '#5b8cff' },
    { name: 'cached', points: cached.points, color: '#22c55e' },
    { name: 'buffers', points: buffers.points, color: '#f59e0b' },
    { name: 'free', points: free.points, color: '#374151' },
  ];
  return (
    <MetricCard
      title="Memory breakdown"
      sub="active / cached / buffers / free"
      error={error}
      action={<CsvButton slug="memory-breakdown" range={range} series={series} />}
    >
      <StackedAreaChart series={series} height={200} format="bytes" range={range} enableBrush />
    </MetricCard>
  );
}

function DiskIOCard({ range }) {
  const read = useMetric('disk.read', range);
  const write = useMetric('disk.write', range);
  const error = read.error || write.error;
  const series = [
    { name: 'read', points: read.points, color: '#5b8cff' },
    { name: 'write', points: write.points, color: '#f59e0b' },
  ];
  return (
    <MetricCard
      title="Disk I/O"
      sub="read / write"
      error={error}
      action={<CsvButton slug="disk-io" range={range} series={series} />}
    >
      <MultiLineChart series={series} height={200} format="rate" range={range} enableBrush />
    </MetricCard>
  );
}

function NetworkIOCard({ range }) {
  const rx = useMetric('net_rx', range);
  const tx = useMetric('net_tx', range);
  const error = rx.error || tx.error;
  const series = [
    { name: 'in', points: rx.points, color: '#22c55e' },
    { name: 'out', points: tx.points, color: '#5b8cff' },
  ];
  return (
    <MetricCard
      title="Network I/O"
      sub="in / out"
      error={error}
      action={<CsvButton slug="network-io" range={range} series={series} />}
    >
      <MultiLineChart series={series} height={200} format="rate" range={range} enableBrush />
    </MetricCard>
  );
}

function ConnectionsCard({ range }) {
  const established = useMetric('conn.established', range);
  const timewait = useMetric('conn.timewait', range);
  const listening = useMetric('conn.listening', range);
  const error = established.error || timewait.error || listening.error;
  const series = [
    { name: 'established', points: established.points, color: '#22c55e' },
    { name: 'time-wait', points: timewait.points, color: '#f59e0b' },
    { name: 'listening', points: listening.points, color: '#5b8cff' },
  ];
  return (
    <MetricCard
      title="Sockets"
      sub="established / time-wait / listening"
      error={error}
      action={<CsvButton slug="connections" range={range} series={series} />}
    >
      <MultiLineChart series={series} height={200} format="number" range={range} enableBrush />
    </MetricCard>
  );
}

function useCoreSeries(cores, range) {
  const [series, setSeries] = useState([]);
  useEffect(() => {
    if (!cores) return undefined;
    let alive = true;
    const refresh = async () => {
      try {
        const results = await Promise.all(
          Array.from({ length: cores }, (_, i) => api.history(`cpu.core.${i}`, range))
        );
        if (!alive) return;
        setSeries(results.map((r, i) => ({
          name: `c${i}`,
          points: r.points || [],
          color: `hsl(${(i * 360) / cores}, 70%, 60%)`,
        })));
      } catch {
        /* leave previous data on error */
      }
    };
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, refreshFor(range));
    return () => { alive = false; clearInterval(id); };
  }, [cores, range]);
  return series;
}

function PerCoreCard({ range, cores }) {
  const series = useCoreSeries(cores, range);
  return (
    <MetricCard
      title="Per-core CPU"
      sub={`${cores} core${cores === 1 ? '' : 's'}`}
      action={<CsvButton slug="cpu-per-core" range={range} series={series} />}
    >
      <MultiLineChart series={series} height={220} format="percent" fixedMax={100} range={range} enableBrush />
    </MetricCard>
  );
}

// Generic poller for a list of dynamic-cardinality series (per-iface, per-disk).
// `entries` is [{ name, metric, color }, ...]. Returns the same shape as
// MultiLineChart.series ({ name, color, points }).
function useDynamicSeries(entries, range) {
  const [series, setSeries] = useState([]);
  const key = entries.map((e) => e.metric).join('|');
  useEffect(() => {
    if (!entries.length) { setSeries([]); return undefined; }
    let alive = true;
    const refresh = async () => {
      try {
        const results = await Promise.all(entries.map((e) => api.history(e.metric, range)));
        if (!alive) return;
        setSeries(entries.map((e, i) => ({
          name: e.name,
          color: e.color,
          points: results[i].points || [],
        })));
      } catch {
        /* keep prior data on error */
      }
    };
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, refreshFor(range));
    return () => { alive = false; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, range]);
  return series;
}

function spreadColors(n) {
  return Array.from({ length: n }, (_, i) => `hsl(${(i * 360) / Math.max(1, n)}, 70%, 60%)`);
}

function PerInterfaceCard({ range, interfaces, direction, title }) {
  const colors = spreadColors(interfaces.length);
  const entries = interfaces.map((name, i) => ({
    name,
    metric: `net.iface.${name}.${direction}`,
    color: colors[i],
  }));
  const series = useDynamicSeries(entries, range);
  return (
    <MetricCard
      title={title}
      sub={`${interfaces.length} interface${interfaces.length === 1 ? '' : 's'}`}
      action={<CsvButton slug={`per-iface-${direction}`} range={range} series={series} />}
    >
      <MultiLineChart series={series} height={200} format="rate" range={range} enableBrush />
    </MetricCard>
  );
}

function PerDiskCard({ range, devices, direction, title }) {
  const colors = spreadColors(devices.length);
  const entries = devices.map((name, i) => ({
    name,
    metric: `disk.dev.${name}.${direction}`,
    color: colors[i],
  }));
  const series = useDynamicSeries(entries, range);
  return (
    <MetricCard
      title={title}
      sub={`${devices.length} device${devices.length === 1 ? '' : 's'}`}
      action={<CsvButton slug={`per-disk-${direction}`} range={range} series={series} />}
    >
      <MultiLineChart series={series} height={200} format="rate" range={range} enableBrush />
    </MetricCard>
  );
}

function Section({ title, children }) {
  return (
    <>
      <h2 className="section-title">{title}</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        {children}
      </div>
    </>
  );
}

// ---------- Saved views ----------

// Pollers are stateful — we can't call useMetric inside a map() because hook
// counts must be stable across renders. This hook fans out to N concurrent
// fetchers via Promise.all, on the same cadence as the rest of the page.
function useViewSeries(metricIds, range) {
  const [series, setSeries] = useState([]);
  const key = metricIds.join('|');
  useEffect(() => {
    if (!metricIds.length) { setSeries([]); return undefined; }
    let alive = true;
    const refresh = async () => {
      try {
        const results = await Promise.all(metricIds.map((id) => api.history(id, range)));
        if (!alive) return;
        setSeries(metricIds.map((id, i) => ({
          name: METRIC_BY_ID[id]?.label || id,
          color: SERIES_COLORS[i % SERIES_COLORS.length],
          points: results[i].points || [],
        })));
      } catch {
        /* keep prior series on error */
      }
    };
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, refreshFor(range));
    return () => { alive = false; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, range]);
  return series;
}

// If every selected metric shares a format, use it; otherwise fall back to
// raw numbers (mixing %/bytes/rate on one axis loses the unit anyway).
function chooseFormat(metricIds) {
  if (!metricIds.length) return 'number';
  const formats = new Set(metricIds.map((id) => METRIC_BY_ID[id]?.format).filter(Boolean));
  if (formats.size === 1) return [...formats][0];
  return 'number';
}

function SavedViewsCard({ range }) {
  const [views, setViews] = useLocalSetting(VIEWS_KEY, []);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState([]); // metric ids in current draft
  const [draftName, setDraftName] = useState('');
  const [activeName, setActiveName] = useState(null); // name of preset whose draft is loaded

  function toggle(id) {
    setSelected((s) => {
      if (s.includes(id)) return s.filter((x) => x !== id);
      if (s.length >= MAX_METRICS_PER_VIEW) return s;
      return [...s, id];
    });
  }
  function clearAll() {
    setSelected([]);
    setDraftName('');
    setActiveName(null);
  }
  function applyPreset(v) {
    setSelected(v.metrics.filter((id) => METRIC_BY_ID[id]));
    setDraftName(v.name);
    setActiveName(v.name);
    setPicking(true);
  }
  function saveCurrent() {
    const name = draftName.trim();
    if (!name || !selected.length) return;
    const next = views.filter((v) => v.name !== name);
    next.unshift({ name, metrics: selected });
    setViews(next.slice(0, MAX_VIEWS));
    setActiveName(name);
  }
  function deleteView(name) {
    setViews(views.filter((v) => v.name !== name));
    if (activeName === name) {
      setActiveName(null);
      setDraftName('');
    }
  }

  const series = useViewSeries(selected, range);
  const format = chooseFormat(selected);
  const fixedMax = format === 'percent' ? 100 : undefined;
  const groupedMetrics = useMemo(
    () => VIEW_GROUPS.map((g) => ({ group: g, items: VIEW_METRICS.filter((m) => m.group === g) })),
    []
  );

  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">Saved views</div>
          <div className="card-sub" style={{ fontSize: 12 }}>
            Pick a handful of metrics to overlay on a single chart. Mix-and-match
            within one unit (all rate, all percent, …) for a clean axis. Saves
            to localStorage per browser.
          </div>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {!picking && (
            <button
              type="button"
              className="btn compact"
              onClick={() => setPicking(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <IconPlus /> Build view
            </button>
          )}
        </div>
      </div>

      {/* Saved presets */}
      {views.length > 0 && (
        <div className="toolbar" style={{ marginTop: 12, gap: 6, flexWrap: 'wrap' }}>
          <span className="dim" style={{ fontSize: 12 }}>Presets:</span>
          {views.map((v) => (
            <span key={v.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
              <button
                type="button"
                className={`btn tiny ${activeName === v.name ? 'active' : ''}`}
                onClick={() => applyPreset(v)}
                title={`${v.metrics.length} metric${v.metrics.length === 1 ? '' : 's'}: ${v.metrics.join(', ')}`}
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                {v.name}
              </button>
              <button
                type="button"
                className="btn tiny"
                onClick={() => deleteView(v.name)}
                aria-label={`Delete view ${v.name}`}
                title="Delete view"
                style={{
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  borderLeft: 'none',
                  padding: '4px 6px',
                  color: 'var(--text-dim)',
                }}
              >
                <IconTrash />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Picker */}
      {picking && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <span className="dim" style={{ fontSize: 12 }}>
              {selected.length} of {MAX_METRICS_PER_VIEW} selected
              {selected.length > 0 && ` · y-axis: ${format}`}
            </span>
            <button
              type="button"
              className="btn tiny ghost pushright"
              onClick={clearAll}
              disabled={selected.length === 0}
            >
              clear
            </button>
            <button
              type="button"
              className="btn tiny ghost"
              onClick={() => setPicking(false)}
            >
              hide
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            {groupedMetrics.map(({ group, items }) => (
              <div key={group}>
                <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
                  {group}
                </div>
                <div style={{ display: 'grid', gap: 4 }}>
                  {items.map((m) => {
                    const checked = selected.includes(m.id);
                    const cap = !checked && selected.length >= MAX_METRICS_PER_VIEW;
                    return (
                      <label
                        key={m.id}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 13,
                          opacity: cap ? 0.4 : 1,
                          cursor: cap ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={cap}
                          onChange={() => toggle(m.id)}
                        />
                        <span>{m.label}</span>
                        <span className="dim mono" style={{ fontSize: 10 }}>{m.format}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); saveCurrent(); }}
            className="toolbar"
            style={{ marginTop: 14 }}
          >
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="view name (e.g. ssh-watch, db-load)"
              maxLength={32}
              className="input"
              style={{ width: 220 }}
            />
            <button
              type="submit"
              className="btn compact"
              disabled={!draftName.trim() || selected.length === 0}
            >
              {activeName === draftName.trim() ? 'Update' : 'Save view'}
            </button>
          </form>
        </div>
      )}

      {/* Live chart */}
      {selected.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <MultiLineChart
            series={series}
            height={240}
            format={format}
            range={range}
            fixedMax={fixedMax}
            enableBrush
          />
          <CsvButton
            slug={`view-${activeName || 'untitled'}`}
            range={range}
            series={series}
          />
        </div>
      )}
    </div>
  );
}

export default function History() {
  const [range, setRange] = useState('1h');
  const [cores, setCores] = useState(0);
  const [interfaces, setInterfaces] = useState([]);
  const [diskDevices, setDiskDevices] = useState([]);
  const [customMetrics, setCustomMetrics] = useState([]);

  // Pull current core count + iface list + disk list + known custom metrics
  // from live endpoints once, so we know which dynamic series to query.
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.cpu().catch(() => null),
      api.network().catch(() => null),
      api.diskio().catch(() => null),
      api.historyMetrics('custom.').catch(() => null),
    ]).then(([c, n, d, m]) => {
      if (!alive) return;
      if (c) setCores(c.cores?.length || c.logicalCores || 0);
      if (n) {
        setInterfaces(
          (n.interfaces || [])
            .filter((it) => it.name !== 'lo' && !/^veth/.test(it.name))
            .map((it) => it.name)
        );
      }
      if (d) setDiskDevices((d.devices || []).map((dev) => dev.name));
      if (m) setCustomMetrics(m.metrics || []);
    });
    return () => { alive = false; };
  }, []);

  return (
    <div className="page-fade-in">
      <h1 className="page-title">History</h1>
      <p className="subtitle">
        Time-series for compute, memory, I/O and network. Sampled every 5s, retained 24h.
      </p>

      <div className="toolbar" style={{ marginBottom: 4 }}>
        {RANGES.map((r) => (
          <button
            key={r}
            className={`btn ghost${r === range ? ' active' : ''}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <h2 className="section-title">Saved views</h2>
      <SavedViewsCard range={range} />

      <Section title="Compute">
        <SingleChartCard metric="cpu" title="CPU usage" format="percent" fixedMax={100} range={range} />
        <CpuBreakdownCard range={range} />
        <SingleChartCard metric="load1" title="Load average (1m)" format="number" range={range} />
      </Section>

      {cores > 0 && (
        <Section title="Per-core">
          <PerCoreCard range={range} cores={cores} />
        </Section>
      )}

      <Section title="Memory">
        <SingleChartCard metric="mem" title="Memory usage" format="percent" fixedMax={100} range={range} />
        <MemoryBreakdownCard range={range} />
      </Section>

      <Section title="I/O">
        <DiskIOCard range={range} />
        <SingleChartCard metric="disk_root" title="Disk usage (/)" format="percent" fixedMax={100} range={range} />
      </Section>

      {diskDevices.length > 0 && (
        <Section title="Per-disk I/O">
          <PerDiskCard range={range} devices={diskDevices} direction="read" title="Disk read · per device" />
          <PerDiskCard range={range} devices={diskDevices} direction="write" title="Disk write · per device" />
        </Section>
      )}

      <Section title="Network">
        <NetworkIOCard range={range} />
      </Section>

      {interfaces.length > 0 && (
        <Section title="Per-interface network">
          <PerInterfaceCard range={range} interfaces={interfaces} direction="rx" title="Network in · per interface" />
          <PerInterfaceCard range={range} interfaces={interfaces} direction="tx" title="Network out · per interface" />
        </Section>
      )}

      <Section title="Connections">
        <ConnectionsCard range={range} />
      </Section>

      {customMetrics.length > 0 && (
        <CustomMetricsSection metrics={customMetrics} range={range} />
      )}
    </div>
  );
}

// `custom.<host>.<leaf>` is the multi-host attribution form (v0.23.0). Older
// agents push `custom.<leaf>` with no host segment — those land in an
// "Ungrouped" section so existing dashboards keep working unchanged.
function parseCustom(name) {
  const tail = name.replace(/^custom\./, '');
  const dot = tail.indexOf('.');
  if (dot > 0) {
    const host = tail.slice(0, dot);
    if (/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/.test(host)) {
      return { host, leaf: tail.slice(dot + 1) };
    }
  }
  return { host: null, leaf: tail };
}

function CustomMetricsSection({ metrics, range }) {
  // Group by host, preserve sorted order, give the no-host group a stable key.
  const byHost = {};
  for (const m of metrics) {
    const { host, leaf } = parseCustom(m);
    const key = host || '__ungrouped__';
    (byHost[key] = byHost[key] || []).push({ metric: m, leaf });
  }
  const hostKeys = Object.keys(byHost).sort((a, b) => {
    if (a === '__ungrouped__') return 1;
    if (b === '__ungrouped__') return -1;
    return a.localeCompare(b);
  });
  return (
    <>
      {hostKeys.map((hk) => {
        const list = byHost[hk];
        const title = hk === '__ungrouped__'
          ? `Custom · ungrouped (${list.length})`
          : `Custom · ${hk} (${list.length})`;
        return (
          <Section key={hk} title={title}>
            {list.map(({ metric, leaf }) => (
              <SingleChartCard
                key={metric}
                metric={metric}
                title={leaf}
                format="number"
                range={range}
              />
            ))}
          </Section>
        );
      })}
    </>
  );
}
