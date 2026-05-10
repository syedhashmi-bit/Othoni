'use strict';

// Optional Prometheus exporter. Off by default — enable by setting
// OTHONI_PROMETHEUS_TOKEN in .env. The endpoint then expects a
// `Authorization: Bearer <token>` header (constant-time compared) and
// returns a standard text-based exposition response.
//
// This is deliberately additive — othoni's primary store is still its own
// SQLite ring buffer. Existing users who don't run Prometheus see no
// behaviour change.

const crypto = require('crypto');

const { getCpu }     = require('./collectors/cpu');
const { getMemory }  = require('./collectors/memory');
const { getNetwork } = require('./collectors/network');
const { getDisks }   = require('./collectors/disks');
const { getDiskIO }  = require('./collectors/diskio');
const { getConnections } = require('./collectors/connections');
const alerts = require('./alerts');
const checks = require('./checks');

const VERSION = require('../package.json').version;

function isEnabled() {
  return !!(process.env.OTHONI_PROMETHEUS_TOKEN && process.env.OTHONI_PROMETHEUS_TOKEN.trim());
}

// Bearer-token check, constant-time. Returns 404 if the exporter is
// disabled (don't advertise it via 401), 401 if the token is missing or
// wrong, otherwise null (callable means "allowed").
function checkAuth(req) {
  if (!isEnabled()) return { status: 404 };
  const expected = process.env.OTHONI_PROMETHEUS_TOKEN;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return { status: 401 };
  const got = header.slice(7);
  if (got.length !== expected.length) return { status: 401 };
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return { status: 401 };
  return null;
}

// Escape a label value per the Prometheus exposition spec: backslashes,
// newlines, and double quotes get backslash-escaped. Keep this strict —
// scrape tools will silently misparse otherwise.
function escapeLabel(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function fmtLabels(labels) {
  const keys = Object.keys(labels || {});
  if (!keys.length) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',') + '}';
}

// Tiny builder. Each call appends one metric block (HELP + TYPE + samples).
class Builder {
  constructor() { this.out = []; }
  block(name, help, type, samples) {
    if (!samples.length) return;
    this.out.push(`# HELP ${name} ${help}`);
    this.out.push(`# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      if (value == null || !Number.isFinite(value)) continue;
      this.out.push(`${name}${fmtLabels(labels)} ${value}`);
    }
  }
  text() { return this.out.join('\n') + '\n'; }
}

async function buildExposition() {
  const [cpu, memory, network, disks, diskio, connections] = await Promise.all([
    getCpu().catch(() => null),
    getMemory().catch(() => null),
    getNetwork().catch(() => null),
    getDisks().catch(() => null),
    getDiskIO().catch(() => null),
    getConnections().catch(() => null),
  ]);

  const b = new Builder();

  // --- meta ---
  b.block(
    'othoni_build_info',
    'Static info about this othoni instance.',
    'gauge',
    [[{ version: VERSION }, 1]]
  );

  // --- compute ---
  b.block(
    'othoni_cpu_usage_percent',
    'Aggregate CPU utilization (0–100).',
    'gauge',
    [[{}, cpu?.usage]]
  );
  b.block(
    'othoni_load_average',
    'Linux load average over the standard windows.',
    'gauge',
    [
      [{ window: '1m'  }, cpu?.loadAverage?.[0]],
      [{ window: '5m'  }, cpu?.loadAverage?.[1]],
      [{ window: '15m' }, cpu?.loadAverage?.[2]],
    ]
  );
  if (cpu?.cores?.length) {
    b.block(
      'othoni_cpu_core_usage_percent',
      'Per-core CPU utilization (0–100).',
      'gauge',
      cpu.cores.map((c, i) => [{ core: String(i) }, c.load])
    );
  }

  // --- memory ---
  b.block(
    'othoni_memory_usage_percent',
    'RAM utilization (0–100).',
    'gauge',
    [[{}, memory?.usagePercent]]
  );
  b.block(
    'othoni_memory_bytes',
    'Memory regions in bytes.',
    'gauge',
    [
      [{ region: 'total'   }, memory?.total],
      [{ region: 'used'    }, memory?.used],
      [{ region: 'active'  }, memory?.active],
      [{ region: 'cached'  }, memory?.cached],
      [{ region: 'buffers' }, memory?.buffers],
      [{ region: 'free'    }, memory?.free],
    ]
  );
  if (memory?.swapTotal) {
    b.block(
      'othoni_swap_usage_percent',
      'Swap utilization (0–100).',
      'gauge',
      [[{}, memory.swapPercent]]
    );
  }

  // --- disks (filesystem usage) ---
  if (disks?.disks?.length) {
    b.block(
      'othoni_filesystem_usage_percent',
      'Per-mount filesystem utilization (0–100).',
      'gauge',
      disks.disks.map((d) => [{ mount: d.mount, fs: d.filesystem || '' }, d.usagePercent])
    );
    b.block(
      'othoni_filesystem_bytes',
      'Per-mount filesystem capacity / used / available in bytes.',
      'gauge',
      disks.disks.flatMap((d) => [
        [{ mount: d.mount, kind: 'size'      }, d.size],
        [{ mount: d.mount, kind: 'used'      }, d.used],
        [{ mount: d.mount, kind: 'available' }, d.available],
      ])
    );
  }

  // --- disk I/O ---
  if (diskio?.devices?.length) {
    b.block(
      'othoni_disk_read_bytes_per_second',
      'Per-device disk read throughput.',
      'gauge',
      diskio.devices.map((d) => [{ device: d.name }, d.readBytesPerSec])
    );
    b.block(
      'othoni_disk_write_bytes_per_second',
      'Per-device disk write throughput.',
      'gauge',
      diskio.devices.map((d) => [{ device: d.name }, d.writeBytesPerSec])
    );
  }

  // --- network ---
  if (network?.interfaces?.length) {
    const real = network.interfaces.filter((i) => !i.isLoopback && !/^veth/.test(i.name));
    b.block(
      'othoni_network_rx_bytes_per_second',
      'Per-interface receive throughput.',
      'gauge',
      real.map((i) => [{ iface: i.name }, i.rxBytesPerSec])
    );
    b.block(
      'othoni_network_tx_bytes_per_second',
      'Per-interface transmit throughput.',
      'gauge',
      real.map((i) => [{ iface: i.name }, i.txBytesPerSec])
    );
    b.block(
      'othoni_network_rx_bytes_total',
      'Per-interface receive total since boot.',
      'counter',
      real.map((i) => [{ iface: i.name }, i.rxBytes])
    );
    b.block(
      'othoni_network_tx_bytes_total',
      'Per-interface transmit total since boot.',
      'counter',
      real.map((i) => [{ iface: i.name }, i.txBytes])
    );
  }

  // --- connections ---
  if (connections?.summary) {
    const s = connections.summary;
    b.block(
      'othoni_connections',
      'TCP socket count by state.',
      'gauge',
      [
        [{ state: 'established' }, s.established || 0],
        [{ state: 'time_wait'   }, s.timeWait    || 0],
        [{ state: 'listening'   }, s.listening   || 0],
      ]
    );
  }

  // --- alerts ---
  // Emit one row per currently-firing alert. Absence of a row = not firing.
  // Scrape tools care about transitions, which they detect from presence.
  // Wrap in try/catch so an uninitialized state (e.g. during a scrape that
  // races startup) doesn't fail the whole response.
  let active = [];
  try { active = alerts.getActive() || []; } catch { /* skip alerts block */ }
  b.block(
    'othoni_alert_firing',
    'Alerts currently firing (1 = firing, no row = not firing).',
    'gauge',
    active.map((a) => [{ rule_id: a.id, severity: a.severity, label: a.label || '', metric: a.metric }, 1])
  );

  // --- synthetic checks ---
  let checkList = [];
  try { checkList = checks.listChecks() || []; } catch { /* skip checks block */ }
  b.block(
    'othoni_check_up',
    'Synthetic check up/down (1 = up, 0 = down, no row = pending).',
    'gauge',
    checkList
      .filter((c) => c.lastUp != null)
      .map((c) => [{ check_id: c.id, label: c.label || '', type: c.type }, c.lastUp])
  );
  b.block(
    'othoni_check_latency_ms',
    'Synthetic check last observed latency.',
    'gauge',
    checkList
      .filter((c) => c.lastLatencyMs != null && c.lastUp === 1)
      .map((c) => [{ check_id: c.id, label: c.label || '', type: c.type }, c.lastLatencyMs])
  );
  b.block(
    'othoni_check_consecutive_failures',
    'Number of consecutive failed runs per check (resets to 0 on a successful run).',
    'gauge',
    checkList.map((c) => [{ check_id: c.id, label: c.label || '', type: c.type }, c.consecutiveFailures || 0])
  );

  return b.text();
}

async function handleRequest(req, res) {
  const denial = checkAuth(req);
  if (denial) {
    res.status(denial.status).type('text/plain');
    res.end(denial.status === 404 ? 'not found\n' : 'unauthorized\n');
    return;
  }
  try {
    const body = await buildExposition();
    res.status(200).type('text/plain; version=0.0.4; charset=utf-8');
    res.end(body);
  } catch (e) {
    res.status(500).type('text/plain').end(`scrape failed: ${e.message}\n`);
  }
}

module.exports = { handleRequest, isEnabled, buildExposition };
