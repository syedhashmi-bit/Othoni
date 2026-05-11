'use strict';

// Per-host snapshot for the /hosts dashboard view (v0.30.0). Auto-
// discovers hosts from the `custom.<host>.*` metric names that
// v0.23.0's host attribution lays down, then returns the latest
// value of each known agent metric per host plus a "last seen"
// timestamp.
//
// The set of "known agent metrics" mirrors what the bundled v0.25.0
// agent.sh pushes — cpu, mem, load1, disk_root, net_rx, net_tx —
// but any other `custom.*` leaves the agent might emit are exposed
// in an `extras` map so operators using a custom agent don't lose
// visibility.

const history = require('./history');

// Same DNS-style host pattern the ingest endpoint enforces, so we
// never surface a "host" that won't round-trip. Single-char host is
// also valid (mirror of server/routes/metrics.js).
const HOST_RE = /^custom\.([a-z0-9][a-z0-9-]{0,38}[a-z0-9]|[a-z0-9])\.(.+)$/;

// Leaves we render as named cards on the host tile. Agent.sh pushes
// these directly; anything else from a custom agent lands in `extras`.
const KNOWN_LEAVES = new Set([
  'cpu',
  'mem',
  'load1',
  'disk_root',
  'net_rx',
  'net_tx',
]);

const DEFAULT_RECENT_MS = 10 * 60 * 1000; // 10 min — anything older = "stale"

function getHosts({ recentMs = DEFAULT_RECENT_MS } = {}) {
  const db = history.getDb();
  const cutoff = Date.now() - Math.max(60_000, recentMs);

  // Discover host-namespaced metrics. Only include series with at
  // least one sample inside the cutoff window — stale hosts that
  // have stopped reporting filter out naturally as samples roll off
  // the 24h retention.
  const rows = db
    .prepare(
      `SELECT metric, MAX(t) AS lastT
       FROM samples
       WHERE metric LIKE 'custom.%' AND t >= ?
       GROUP BY metric`
    )
    .all(cutoff);

  const byHost = new Map();
  for (const r of rows) {
    const m = HOST_RE.exec(r.metric);
    if (!m) continue;
    const host = m[1];
    const leaf = m[2];
    if (!byHost.has(host)) {
      byHost.set(host, { host, lastSeenAt: 0, metrics: {}, extras: {}, leafMetrics: {} });
    }
    const slot = byHost.get(host);
    slot.lastSeenAt = Math.max(slot.lastSeenAt, r.lastT);
    slot.leafMetrics[leaf] = r.metric;
  }

  // Fetch the latest value of each leaf per host. One indexed point
  // lookup per metric — cheap on the (metric, t) index.
  const latestStmt = db.prepare(
    `SELECT t, v FROM samples WHERE metric = ? ORDER BY t DESC LIMIT 1`
  );

  const out = [];
  for (const slot of byHost.values()) {
    for (const [leaf, metricName] of Object.entries(slot.leafMetrics)) {
      const row = latestStmt.get(metricName);
      if (!row) continue;
      const entry = { t: row.t, v: row.v, metric: metricName };
      if (KNOWN_LEAVES.has(leaf)) slot.metrics[leaf] = entry;
      else slot.extras[leaf] = entry;
    }
    out.push({
      host: slot.host,
      lastSeenAt: slot.lastSeenAt,
      metrics: slot.metrics,
      extras: slot.extras,
    });
  }

  // Newest first.
  out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return out;
}

module.exports = { getHosts, KNOWN_LEAVES };
