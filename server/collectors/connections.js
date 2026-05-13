'use strict';

const fs = require('fs').promises;

// Linux kernel TCP state constants (hex strings as they appear in /proc/net/tcp).
const TCP_STATES = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
  '0C': 'NEW_SYN_RECV',
};

// Cap on the number of active (non-LISTEN) rows we return per call so a busy
// server doesn't blow the response size. Listening rows are always included.
const ACTIVE_LIMIT = 1000;

// IPv4: 8 hex chars in little-endian byte order. "0100007F" → "127.0.0.1".
function parseHexIp4(hex) {
  const a = parseInt(hex.slice(6, 8), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const c = parseInt(hex.slice(2, 4), 16);
  const d = parseInt(hex.slice(0, 2), 16);
  return `${a}.${b}.${c}.${d}`;
}

// IPv6: 32 hex chars = 4 little-endian 32-bit words = 16 bytes. Group into
// 8 colon-separated 16-bit groups, then collapse the longest run of zeros
// into "::" (one pass, only if there's a run of ≥2).
function parseHexIp6(hex) {
  const bytes = [];
  for (let i = 0; i < 4; i++) {
    const word = hex.slice(i * 8, (i + 1) * 8);
    for (let j = 3; j >= 0; j--) bytes.push(word.slice(j * 2, j * 2 + 2));
  }
  const groups = [];
  for (let i = 0; i < 8; i++) {
    groups.push(parseInt(bytes[i * 2] + bytes[i * 2 + 1], 16).toString(16));
  }
  // Collapse longest run of "0" groups into "::".
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen >= 2) {
    const before = groups.slice(0, bestStart).join(':');
    const after = groups.slice(bestStart + bestLen).join(':');
    return `${before}::${after}`;
  }
  return groups.join(':');
}

function parseAddr(addrPort, isV6) {
  const idx = addrPort.lastIndexOf(':');
  const hex = addrPort.slice(0, idx);
  const portHex = addrPort.slice(idx + 1);
  const ip = isV6 ? parseHexIp6(hex) : parseHexIp4(hex);
  const port = parseInt(portHex, 16);
  return { ip, port };
}

function parseLines(text, family, isV6) {
  const lines = text.split('\n').slice(1); // skip header
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const local = parseAddr(cols[1], isV6);
    const remote = parseAddr(cols[2], isV6);
    const stateHex = cols[3].toUpperCase();
    const state = family === 'tcp' ? (TCP_STATES[stateHex] || stateHex) : 'STATELESS';
    out.push({
      protocol: family + (isV6 ? '6' : ''),
      local,
      remote,
      state,
    });
  }
  return out;
}

async function readMaybe(path) {
  try { return await fs.readFile(path, 'utf8'); } catch { return null; }
}

async function getConnections() {
  const [tcp4, tcp6, udp4, udp6] = await Promise.all([
    readMaybe('/proc/net/tcp'),
    readMaybe('/proc/net/tcp6'),
    readMaybe('/proc/net/udp'),
    readMaybe('/proc/net/udp6'),
  ]);

  const all = [
    ...(tcp4 ? parseLines(tcp4, 'tcp', false) : []),
    ...(tcp6 ? parseLines(tcp6, 'tcp', true) : []),
    ...(udp4 ? parseLines(udp4, 'udp', false) : []),
    ...(udp6 ? parseLines(udp6, 'udp', true) : []),
  ];

  // Listening = TCP LISTEN sockets + all UDP sockets (UDP is connectionless;
  // any UDP socket bound to a port is effectively "listening").
  const listeningRaw = all.filter(
    (c) => (c.protocol.startsWith('tcp') && c.state === 'LISTEN') || c.protocol.startsWith('udp')
  );
  // Group by (protocol, port) so the same service bound on 0.0.0.0 + :: shows
  // as one row with both bind addresses listed.
  const listenMap = new Map();
  for (const c of listeningRaw) {
    const key = `${c.protocol.replace(/6$/, '')}:${c.local.port}`;
    if (!listenMap.has(key)) {
      listenMap.set(key, {
        protocol: c.protocol.replace(/6$/, ''),
        port: c.local.port,
        addresses: [],
      });
    }
    listenMap.get(key).addresses.push(`${c.local.ip} (${c.protocol})`);
  }
  const listening = Array.from(listenMap.values()).sort((a, b) => a.port - b.port);

  const activeAll = all.filter((c) => c.protocol.startsWith('tcp') && c.state !== 'LISTEN');
  const active = activeAll.slice(0, ACTIVE_LIMIT);

  // Summary by TCP state (across v4 + v6).
  const stateCounts = {};
  for (const c of all) {
    if (!c.protocol.startsWith('tcp')) continue;
    stateCounts[c.state] = (stateCounts[c.state] || 0) + 1;
  }

  // ---- Top talkers ----
  // Computed from the FULL activeAll set (not the capped `active` slice) so
  // grouping isn't skewed when a host has more than ACTIVE_LIMIT connections.
  // The intent is to make SSH brute-force / scrape patterns obvious at a glance:
  //   - topLocalPorts: which of OUR ports has the most connections (e.g. 22)
  //   - topRemoteAddresses: which remote IP is hammering us (concentrated source)
  const topLocalPorts = aggregateBy(
    activeAll,
    (c) => c.local.port,
    (c, agg) => {
      agg.port  = c.local.port;
      agg.proto = c.protocol.replace(/6$/, '');
    }
  );
  const topRemoteAddresses = aggregateBy(
    activeAll,
    (c) => c.remote.ip,
    (c, agg) => {
      agg.ip = c.remote.ip;
      // Top remote ports per IP (which services on the talker is hitting which
      // of our ports — for an SSH brute-forcer the only port will be 22).
      const k = `${c.local.port}`;
      agg._localPorts = agg._localPorts || {};
      agg._localPorts[k] = (agg._localPorts[k] || 0) + 1;
    }
  ).map((row) => {
    const ports = Object.entries(row._localPorts || {})
      .map(([port, n]) => ({ port: Number(port), n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 4);
    delete row._localPorts;
    return { ...row, ports };
  });

  return {
    summary: {
      tcp4: all.filter((c) => c.protocol === 'tcp').length,
      tcp6: all.filter((c) => c.protocol === 'tcp6').length,
      udp4: all.filter((c) => c.protocol === 'udp').length,
      udp6: all.filter((c) => c.protocol === 'udp6').length,
      listening: listening.length,
      established: stateCounts.ESTABLISHED || 0,
      timeWait: stateCounts.TIME_WAIT || 0,
      states: stateCounts,
    },
    listening,
    active,
    activeTotal: activeAll.length,
    truncated: activeAll.length > ACTIVE_LIMIT,
    topLocalPorts,
    topRemoteAddresses,
  };
}

// Generic top-N aggregator. `keyFn` returns the group key per row; `mergeFn`
// gets the row + the (mutable) accumulator and writes any extra fields beyond
// the auto-counted total + per-state breakdown. Returns the top 10 by total,
// with state counts trimmed to the top 4 for compact rendering.
const TOP_N = 10;
const TOP_STATES_PER_ROW = 4;
function aggregateBy(rows, keyFn, mergeFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    let agg = m.get(k);
    if (!agg) {
      agg = { total: 0, states: {} };
      m.set(k, agg);
    }
    agg.total++;
    agg.states[r.state] = (agg.states[r.state] || 0) + 1;
    mergeFn(r, agg);
  }
  return Array.from(m.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_N)
    .map((agg) => {
      const sorted = Object.entries(agg.states).sort((a, b) => b[1] - a[1]);
      const top = sorted.slice(0, TOP_STATES_PER_ROW);
      const other = sorted.slice(TOP_STATES_PER_ROW).reduce((s, [, n]) => s + n, 0);
      const states = Object.fromEntries(top);
      if (other > 0) states.other = other;
      return { ...agg, states };
    });
}

// Lightweight summary used by the metrics sampler (history.js). Reads the
// same 4 /proc files but only counts lines by state — no hex IP parsing, no
// top-talker aggregation. ~10x cheaper than getConnections() per call.
async function getConnectionsSummary() {
  const [tcp4, tcp6, udp4, udp6] = await Promise.all([
    readMaybe('/proc/net/tcp'),
    readMaybe('/proc/net/tcp6'),
    readMaybe('/proc/net/udp'),
    readMaybe('/proc/net/udp6'),
  ]);

  function count(text, isTcp) {
    if (!text) return { total: 0, listen: 0, established: 0, timeWait: 0 };
    const lines = text.split('\n');
    let total = 0, listen = 0, established = 0, timeWait = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].trim().split(/\s+/);
      if (cols.length < 4) continue;
      total++;
      if (isTcp) {
        const s = cols[3].toUpperCase();
        if (s === '0A') listen++;
        else if (s === '01') established++;
        else if (s === '06') timeWait++;
      }
    }
    return { total, listen, established, timeWait };
  }

  const t4 = count(tcp4, true);
  const t6 = count(tcp6, true);
  const u4 = count(udp4, false);
  const u6 = count(udp6, false);

  const established = t4.established + t6.established;
  const timeWait    = t4.timeWait    + t6.timeWait;
  const listenTcp   = t4.listen      + t6.listen;

  return {
    summary: {
      tcp4:        t4.total,
      tcp6:        t6.total,
      udp4:        u4.total,
      udp6:        u6.total,
      listening:   listenTcp + u4.total + u6.total,
      established,
      timeWait,
      states: { ESTABLISHED: established, TIME_WAIT: timeWait, LISTEN: listenTcp },
    },
  };
}

module.exports = { getConnections, getConnectionsSummary };
