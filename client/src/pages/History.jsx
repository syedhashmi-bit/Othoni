import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { LineChart, MultiLineChart, StackedAreaChart } from '../Charts.jsx';

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
        <Section title={`Custom (${customMetrics.length})`}>
          {customMetrics.map((m) => (
            <SingleChartCard
              key={m}
              metric={m}
              title={m.replace(/^custom\./, '')}
              format="number"
              range={range}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
