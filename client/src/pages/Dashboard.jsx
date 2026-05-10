import React, { useCallback, useMemo } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { formatBytes, formatRate, formatUptime, statusClass } from '../utils';
import { useApp } from '../App.jsx';
import { Sparkline, MultiLineChart, CoreGrid } from '../Charts.jsx';
import { IconCpu, IconMemory, IconDisk, IconActivity } from '../Icons.jsx';

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

function StatCard({ title, value, sub, percent, spark, sparkMax, sparkFormat, sparkStats, icon: Icon }) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {Icon && <Icon style={{ color: 'var(--text-dim)' }} />}
          <span>{title}</span>
        </div>
      </div>
      <div className="card-value">{value}</div>
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
    </div>
  );
}

export default function Dashboard() {
  const { refreshMs } = useApp();
  const { data, error, loading } = usePoller(api.overview, refreshMs);

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

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Dashboard</h1>
      <p className="subtitle">
        {system.distro} {system.release} · {system.hostname} · up{' '}
        {formatUptime(system.uptimeSeconds)}
      </p>

      {/* Hero chart — last hour, CPU + Memory overlay */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Last hour — CPU &amp; Memory</div>
          <div className="card-sub">refreshes every 30s</div>
        </div>
        <MultiLineChart series={heroSeries} height={200} format="percent" range="1h" fixedMax={100} />
      </div>

      <div className="spacer-md" />

      {/* At-a-glance cards with per-15min sparklines */}
      <div className="grid cols-4">
        <StatCard
          icon={IconCpu}
          title="CPU usage"
          value={`${cpu.usage.toFixed(1)}%`}
          sub={`${cpu.physicalCores} cores · load ${cpu.loadAverage.join(' / ')}`}
          percent={cpu.usage}
          spark={cpuSpark}
          sparkMax={100}
          sparkFormat="percent"
          sparkStats
        />
        <StatCard
          icon={IconMemory}
          title="RAM usage"
          value={`${memory.usagePercent.toFixed(1)}%`}
          sub={`${formatBytes(memory.active)} / ${formatBytes(memory.total)}`}
          percent={memory.usagePercent}
          spark={memSpark}
          sparkMax={100}
          sparkFormat="percent"
          sparkStats
        />
        <StatCard
          icon={IconDisk}
          title="Disk (/)"
          value={root ? `${root.usagePercent.toFixed(1)}%` : '—'}
          sub={root ? `${formatBytes(root.used)} / ${formatBytes(root.size)}` : 'no data'}
          percent={root?.usagePercent}
          spark={diskSpark}
          sparkMax={100}
          sparkFormat="percent"
          sparkStats
        />
        <StatCard
          icon={IconActivity}
          title="Network"
          value={`${formatRate(rx)} ↓`}
          sub={`${formatRate(tx)} ↑ across ${nonLo.length} iface${nonLo.length === 1 ? '' : 's'}`}
          spark={netRxSpark}
          sparkFormat="rate"
          sparkStats
        />
      </div>

      <div className="spacer-md" />

      {/* Per-core CPU + Disk I/O */}
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <div className="card-title">CPU per core</div>
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

      <div className="spacer-md" />

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

      <div className="spacer-md" />

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
    </div>
  );
}
