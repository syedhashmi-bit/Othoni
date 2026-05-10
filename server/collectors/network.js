'use strict';

const fs = require('fs').promises;

const previous = new Map(); // iface -> { rxBytes, txBytes, t }

function parseProcNetDev(text) {
  const lines = text.split('\n').slice(2);
  const ifaces = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const cols = rest.trim().split(/\s+/);
    if (cols.length < 16) continue;
    ifaces.push({
      name: name.trim(),
      rxBytes: Number(cols[0]),
      rxPackets: Number(cols[1]),
      rxErrors: Number(cols[2]),
      rxDropped: Number(cols[3]),
      txBytes: Number(cols[8]),
      txPackets: Number(cols[9]),
      txErrors: Number(cols[10]),
      txDropped: Number(cols[11]),
    });
  }
  return ifaces;
}

async function getNetwork() {
  const raw = await fs.readFile('/proc/net/dev', 'utf8');
  const ifaces = parseProcNetDev(raw);
  const now = Date.now();
  const result = [];
  for (const it of ifaces) {
    const prev = previous.get(it.name);
    let rxSpeed = 0;
    let txSpeed = 0;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        rxSpeed = Math.max(0, (it.rxBytes - prev.rxBytes) / dt);
        txSpeed = Math.max(0, (it.txBytes - prev.txBytes) / dt);
      }
    }
    previous.set(it.name, { rxBytes: it.rxBytes, txBytes: it.txBytes, t: now });
    result.push({
      name: it.name,
      rxBytes: it.rxBytes,
      txBytes: it.txBytes,
      rxPackets: it.rxPackets,
      txPackets: it.txPackets,
      rxErrors: it.rxErrors,
      txErrors: it.txErrors,
      rxBytesPerSec: Math.round(rxSpeed),
      txBytesPerSec: Math.round(txSpeed),
      isLoopback: it.name === 'lo',
    });
  }
  return { interfaces: result };
}

// Warm up the previous-counters map so the first request after server start
// returns reasonable numbers (otherwise the very first call shows 0 B/s).
getNetwork().catch(() => {});

module.exports = { getNetwork };
