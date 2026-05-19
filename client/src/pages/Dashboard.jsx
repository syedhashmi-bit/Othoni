import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Link } from 'react-router-dom';
import { usePoller, useLocalSetting, useFlashOnChange, useCountUp } from '../hooks';
import { formatBytes, formatRate, formatUptime, statusClass } from '../utils';
import { useApp } from '../App.jsx';
import { Sparkline, MultiLineChart, CoreGrid, Heatmap } from '../Charts.jsx';
import { IconCpu, IconMemory, IconDisk, IconActivity } from '../Icons.jsx';

// v0.50 Dashboard layout customization. Each section in the table
// below has a stable id; the on-disk order + visibility live in
// localStorage. Newly-introduced section ids (e.g. after an upgrade)
// get auto-appended visible.
const SECTIONS = [
  { id: 'hero',    label: 'Hero chart (CPU + Memory, 1h)' },
  { id: 'stats',   label: 'Top stat tiles' },
  { id: 'heatmap', label: 'CPU heatmap over time' },
  { id: 'cores',   label: 'Per-core CPU + Disk I/O' },
  { id: 'uptime',  label: 'Uptime / Load / Swap' },
  { id: 'info',    label: 'System / Network / CPU info' },
];
const DEFAULT_LAYOUT = SECTIONS.map((s) => ({ id: s.id, visible: true }));

function reconcileLayout(saved) {
  if (!Array.isArray(saved)) return DEFAULT_LAYOUT.slice();
  const known = new Set(SECTIONS.map((s) => s.id));
  const seen = new Set();
  const out = [];
  for (const row of saved) {
    if (!row || typeof row.id !== 'string' || !known.has(row.id)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, visible: row.visible !== false });
  }
  for (const s of SECTIONS) {
    if (!seen.has(s.id)) out.push({ id: s.id, visible: true });
  }
  return out;
}

function LayoutEditor({ open, onClose, layout, setLayout }) {
  function move(i, delta) {
    setLayout((cur) => {
      const next = cur.slice();
      const j = i + delta;
      if (j < 0 || j >= next.length) return cur;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function toggle(id) {
    setLayout((cur) => cur.map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)));
  }
  function reset() { setLayout(DEFAULT_LAYOUT.slice()); }
  if (!open) return null;
  return (
    <div
      className="popover"
      style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        marginTop: 6,
        zIndex: 20,
        minWidth: 360,
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div className="card-title" style={{ flex: 1, fontSize: 13 }}>Dashboard layout</div>
        <button type="button" className="btn ghost" onClick={reset} style={{ fontSize: 11, padding: '2px 8px' }}>
          reset
        </button>
        <button type="button" className="btn ghost" onClick={onClose} style={{ fontSize: 11, padding: '2px 8px', marginLeft: 4 }}>
          close
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        Reorder + show/hide sections. Saved in this browser only.
      </div>
      <div>
        {layout.map((row, i) => {
          const meta = SECTIONS.find((s) => s.id === row.id);
          if (!meta) return null;
          return (
            <div
              key={row.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 13,
                opacity: row.visible ? 1 : 0.55,
              }}
            >
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={row.visible}
                  onChange={() => toggle(row.id)}
                />
                <span>{meta.label}</span>
              </label>
              <button
                type="button"
                className="btn ghost"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                style={{ padding: '1px 6px', fontSize: 11 }}
                aria-label="Move up"
              >
                ▴
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => move(i, +1)}
                disabled={i === layout.length - 1}
                style={{ padding: '1px 6px', fontSize: 11 }}
                aria-label="Move down"
              >
                ▾
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function useSpark(metric, range = '15m', refreshMs = 15000) {
  const loader = useCallback(() => api.history(metric, range), [metric, range]);
  const { data } = usePoller(loader, refreshMs, [metric, range]);
  return data?.points || [];
}

function Bar({ percent }) {
  const cls = statusClass(percent);
  return (
    <div className={`bar ${cls}`}>
      <div style={{ width: `${Math.min(100, Math.max(0, percent || 0))}%` }} />
    </div>
  );
}

function SkelCard() {
  return (
    <div className="card">
      <div className="skeleton skel-line" style={{ width: '40%' }} />
      <div className="skeleton skel-line" style={{ width: '70%', height: 24, margin: '10px 0 8px' }} />
      <div className="skeleton skel-line" style={{ width: '85%' }} />
      <div className="skeleton skel-block" style={{ marginTop: 12 }} />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="page-fade-in">
      <div className="skeleton skel-line" style={{ width: 220, height: 28 }} />
      <div className="skeleton skel-line" style={{ width: 380, marginTop: 10, marginBottom: 24 }} />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="skeleton skel-line" style={{ width: '30%' }} />
        <div className="skeleton" style={{ height: 200, marginTop: 14, borderRadius: 8 }} />
      </div>
      <div className="grid cols-4">
        {[0, 1, 2, 3].map((i) => <SkelCard key={i} />)}
      </div>
    </div>
  );
}

// v0.45 CPU heatmap. Polls /api/history/cpu-cores for bucketed per-core
// data over the selected range and renders via the Heatmap primitive.
function CpuHeatmapCard() {
  const [range, setRange] = useState('1h');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    function refresh() {
      api.cpuCores({ range })
        .then((r) => { if (!cancel) setData(r); })
        .catch((e) => { if (!cancel) setErr(e.message); });
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancel = true; clearInterval(id); };
  }, [range]);

  const ranges = [
    { value: '15m', label: '15m' },
    { value: '1h',  label: '1h'  },
    { value: '6h',  label: '6h'  },
    { value: '24h', label: '24h' },
  ];

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card-title">CPU heatmap</div>
          <div className="card-sub">
            Per-core load over time. Cool → hot ramps cold blue (idle) →
            amber (~75%) → red (90%+). Hover for the bucket value.
          </div>
        </div>
        <div className="toolbar" style={{ margin: 0, gap: 4 }}>
          {ranges.map((r) => (
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
      {err && <div className="error" style={{ marginTop: 12 }}>{err}</div>}
      {!err && data && (
        <div style={{ marginTop: 12 }}>
          <Heatmap
            cores={data.cores || []}
            bucketMs={data.bucketMs}
            from={data.from}
            to={data.to}
            rangeLabel={range}
          />
        </div>
      )}
      {!err && !data && (
        <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>Loading…</div>
      )}
    </div>
  );
}

function StatCard({ title, value, numericValue, format, sub, percent, spark, sparkMax, sparkFormat, sparkStats, icon: Icon, to }) {
  const flashing = useFlashOnChange(value);
  // When `numericValue` is provided, animate it to the new value over ~320 ms
  // using the count-up tween. Falls back to the pre-formatted string in
  // `value` for callers that don't have a clean numeric (e.g. "1.2 / 0.7 / 0.5").
  const animated = useCountUp(
    typeof numericValue === 'number' ? numericValue : 0,
    { format: format || ((n) => n.toFixed(1)) }
  );
  const displayValue = typeof numericValue === 'number' ? animated : value;
  // When `to` is set, the entire card becomes a navigation link with the
  // .clickable affordance (hover lift + accent border + → arrow on hover).
  const Wrapper = to ? Link : 'div';
  const wrapperProps = to ? { to, className: 'card clickable' } : { className: 'card' };
  return (
    <Wrapper {...wrapperProps}>
      <div className="card-header">
        <div className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {Icon && <Icon style={{ color: 'var(--text-dim)' }} />}
          <span>{title}</span>
        </div>
      </div>
      <div className={`card-value count-up${flashing ? ' value-flash' : ''}`}>{displayValue}</div>
      {sub && <div className="card-sub">{sub}</div>}
      {percent != null && <Bar percent={percent} />}
      {spark && (
        <div style={{ marginTop: 10 }}>
          <Sparkline
            points={spark}
            height={36}
            fixedMax={sparkMax}
            format={sparkFormat}
            showStats={sparkStats}
          />
        </div>
      )}
    </Wrapper>
  );
}

export default function Dashboard() {
  const { refreshMs } = useApp();
  const { data, error, loading } = usePoller(api.overview, refreshMs);
  const [layoutRaw, setLayoutRaw] = useLocalSetting('othoni.dashboardLayout', DEFAULT_LAYOUT);
  const layout = useMemo(() => reconcileLayout(layoutRaw), [layoutRaw]);
  const setLayout = (updater) => {
    setLayoutRaw((cur) => {
      const reconciled = reconcileLayout(cur);
      return typeof updater === 'function' ? updater(reconciled) : updater;
    });
  };
  const [layoutOpen, setLayoutOpen] = useState(false);

  // Sparklines (15min) — small per-card
  const cpuSpark = useSpark('cpu');
  const memSpark = useSpark('mem');
  const netRxSpark = useSpark('net_rx');
  const diskSpark = useSpark('disk_root');
  const diskReadSpark = useSpark('disk.read');
  const diskWriteSpark = useSpark('disk.write');

  // Hero chart (1h CPU + Memory overlay) — refreshes less aggressively
  const cpuHour = useSpark('cpu', '1h', 30000);
  const memHour = useSpark('mem', '1h', 30000);

  const heroSeries = useMemo(
    () => [
      { name: 'CPU', points: cpuHour, color: '#5b8cff' },
      { name: 'Memory', points: memHour, color: '#22c55e' },
    ],
    [cpuHour, memHour]
  );

  if (loading && !data) return <DashboardSkeleton />;
  if (error && !data) return <div className="error">Could not load metrics.</div>;

  const { system, cpu, memory, disks, network, diskio } = data;

  const root = (disks?.disks || []).find((d) => d.mount === '/') || (disks?.disks || [])[0];
  const nonLo = (network?.interfaces || []).filter((i) => !i.isLoopback);
  const rx = nonLo.reduce((s, i) => s + i.rxBytesPerSec, 0);
  const tx = nonLo.reduce((s, i) => s + i.txBytesPerSec, 0);
  const ioRead = diskio?.totalReadBytesPerSec || 0;
  const ioWrite = diskio?.totalWriteBytesPerSec || 0;

  // Sections, keyed by id, each returning a React fragment. Render
  // order + visibility come from the saved layout below.
  const sections = {
    hero: () => (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Last hour — CPU &amp; Memory</div>
          <div className="card-sub">refreshes every 30s</div>
        </div>
        <MultiLineChart series={heroSeries} height={200} format="percent" range="1h" fixedMax={100} />
      </div>
    ),
    stats: () => (
      <div className="grid cols-4">
        <StatCard
          icon={IconCpu}
          title="CPU usage"
          numericValue={cpu.usage}
          format={(n) => `${n.toFixed(1)}%`}
          sub={`${cpu.physicalCores} cores · load ${cpu.loadAverage.join(' / ')}`}
          percent={cpu.usage}
          spark={cpuSpark}
          sparkMax={100}
          sparkFormat="percent"
          sparkStats
          to="/processes"
        />
        <StatCard
          icon={IconMemory}
          title="RAM usage"
          numericValue={memory.usagePercent}
          format={(n) => `${n.toFixed(1)}%`}
          sub={`${formatBytes(memory.active)} / ${formatBytes(memory.total)}`}
          percent={memory.usagePercent}
          spark={memSpark}
          sparkMax={100}
          sparkFormat="percent"
          sparkStats
          to="/history"
        />
        <StatCard
          icon={IconDisk}
          title="Disk (/)"
          numericValue={root ? root.usagePercent : null}
          format={(n) => `${n.toFixed(1)}%`}
          value={root ? undefined : '—'}
          sub={root ? `${formatBytes(root.used)} / ${formatBytes(root.size)}` : 'no data'}
          percent={root?.usagePercent}
          spark={diskSpark}
          sparkMax={100}
          sparkFormat="percent"
          sparkStats
          to="/storage"
        />
        <StatCard
          icon={IconActivity}
          title="Network"
          value={`${formatRate(rx)} ↓`}
          sub={`${formatRate(tx)} ↑ across ${nonLo.length} iface${nonLo.length === 1 ? '' : 's'}`}
          spark={netRxSpark}
          sparkFormat="rate"
          sparkStats
          to="/network"
        />
      </div>
    ),
    heatmap: () => <CpuHeatmapCard />,
    cores: () => (
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <div className="card-title">CPU per core (now)</div>
            <div className="card-sub">
              {cpu.cores?.length} logical · {cpu.physicalCores} physical
              {cpu.temperatureC != null ? ` · ${cpu.temperatureC} °C` : ''}
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <CoreGrid cores={cpu.cores || []} />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Disk I/O</div>
            <div className="card-sub">{(diskio?.devices || []).length} device{(diskio?.devices || []).length === 1 ? '' : 's'}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
            <div>
              <div className="card-sub" style={{ marginBottom: 2 }}>read</div>
              <div className="card-value" style={{ fontSize: 22 }}>{formatRate(ioRead)}</div>
              <div style={{ marginTop: 6 }}>
                <Sparkline points={diskReadSpark} height={32} color="#5b8cff" format="rate" showStats />
              </div>
            </div>
            <div>
              <div className="card-sub" style={{ marginBottom: 2 }}>write</div>
              <div className="card-value" style={{ fontSize: 22 }}>{formatRate(ioWrite)}</div>
              <div style={{ marginTop: 6 }}>
                <Sparkline points={diskWriteSpark} height={32} color="#f59e0b" format="rate" showStats />
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    uptime: () => (
      <div className="grid cols-3">
        <StatCard title="Uptime" value={formatUptime(system.uptimeSeconds)} sub={`booted ${new Date(system.bootTime).toLocaleString()}`} />
        <StatCard title="Load average" value={cpu.loadAverage.join(' / ')} sub="1m / 5m / 15m" />
        <StatCard
          title="Swap"
          value={`${memory.swapPercent.toFixed(1)}%`}
          sub={memory.swapTotal ? `${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}` : 'not configured'}
          percent={memory.swapTotal ? memory.swapPercent : null}
        />
      </div>
    ),
    info: () => (
      <div className="grid cols-3">
        <div className="card">
          <div className="card-header">
            <div className="card-title">System</div>
          </div>
          <dl className="kv">
            <dt>Hostname</dt>
            <dd>{system.hostname}</dd>
            <dt>OS</dt>
            <dd>{system.distro} {system.release}</dd>
            <dt>Kernel</dt>
            <dd className="mono">{system.kernel}</dd>
            <dt>Architecture</dt>
            <dd>{system.arch}</dd>
            <dt>Node.js</dt>
            <dd className="mono">{system.nodejs}</dd>
            <dt>Timezone</dt>
            <dd>{system.timezone}</dd>
          </dl>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Network addresses</div>
          </div>
          <dl className="kv">
            <dt>Public IP</dt>
            <dd className="mono">{system.publicIp || '—'}</dd>
            {system.localIps.length === 0 && (
              <>
                <dt>Local</dt>
                <dd className="muted">none</dd>
              </>
            )}
            {system.localIps.map((ip, i) => (
              <React.Fragment key={i}>
                <dt>{ip.interface}</dt>
                <dd className="mono">
                  {ip.address} <span className="dim">{ip.family}</span>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">CPU</div>
          </div>
          <dl className="kv">
            <dt>Model</dt>
            <dd>{cpu.model || '—'}</dd>
            <dt>Cores</dt>
            <dd>{cpu.physicalCores} physical · {cpu.logicalCores} logical</dd>
            <dt>Speed</dt>
            <dd>{cpu.speedGHz ? `${cpu.speedGHz} GHz` : '—'}</dd>
            <dt>Temperature</dt>
            <dd>{cpu.temperatureC != null ? `${cpu.temperatureC} °C` : '—'}</dd>
            <dt>User / system</dt>
            <dd>{cpu.user.toFixed(1)}% / {cpu.system.toFixed(1)}%</dd>
          </dl>
        </div>
      </div>
    ),
  };

  return (
    <div className="page-fade-in">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, position: 'relative' }}>
        <div style={{ flex: 1 }}>
          <h1 className="page-title">Dashboard</h1>
          <p className="subtitle">
            {system.distro} {system.release} · {system.hostname} · up{' '}
            {formatUptime(system.uptimeSeconds)}
          </p>
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setLayoutOpen((v) => !v)}
            title="Show / hide / reorder dashboard sections (saved per browser)"
          >
            Layout ▾
          </button>
          <LayoutEditor
            open={layoutOpen}
            onClose={() => setLayoutOpen(false)}
            layout={layout}
            setLayout={setLayout}
          />
        </div>
      </div>

      {layout
        .filter((row) => row.visible && sections[row.id])
        .map((row, i, arr) => (
          <React.Fragment key={row.id}>
            {sections[row.id]()}
            {i < arr.length - 1 && <div className="spacer-md" />}
          </React.Fragment>
        ))}
    </div>
  );
}
