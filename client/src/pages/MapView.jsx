import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import FleetMap from '../components/FleetMap.jsx';

function freshClass(lastSeenAt) {
  const age = Date.now() - lastSeenAt;
  if (age < 60_000) return 'ok';
  if (age < 5 * 60_000) return 'warn';
  return 'crit';
}

// Fleet map view (opened from the top-bar "Map" button). Always shows the
// central box's full fleet — `/api/hosts` and `/api/peers` aren't host-scoped,
// so this stays the central perspective even while viewing a peer's dashboard.
export default function MapView() {
  const [hosts, setHosts] = useState([]);
  const [self, setSelf] = useState(null);
  const [peers, setPeers] = useState([]);
  const [err, setErr] = useState(null);

  function refresh() {
    api.hosts()
      .then((r) => { setHosts(r.hosts || []); setSelf(r.self || null); })
      .catch((e) => setErr(e.message));
    api.peers.list().then((r) => setPeers(r.peers || [])).catch(() => { /* peers optional */ });
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, []);

  const nodes = useMemo(() => {
    const byHost = new Map();
    for (const h of hosts) {
      const m = h.meta || {};
      byHost.set(h.host, {
        host: h.host,
        lat: m.lat ?? null,
        lon: m.lon ?? null,
        place: m.place || null,
        status: freshClass(h.lastSeenAt),
        statusLabel: 'agent host',
        link: `/hosts/${encodeURIComponent(h.host)}`,
      });
    }
    // The local box = the main othoni server → mark it primary (rendered as a
    // star). Manual location wins, then IP-detected auto location.
    if (self && self.host) {
      const m = self.meta || {};
      const a = self.auto || {};
      const node = byHost.get(self.host) || { host: self.host, status: 'ok', link: '/' };
      node.primary = true;
      node.statusLabel = 'main server';
      if (node.lat == null) { node.lat = m.lat ?? a.lat ?? null; node.lon = m.lon ?? a.lon ?? null; }
      if (!node.place) node.place = m.place || a.place || null;
      byHost.set(self.host, node);
    }
    for (const p of peers) {
      const pLat = p.lat ?? p.auto?.lat ?? null;
      const pLon = p.lon ?? p.auto?.lon ?? null;
      const pPlace = p.place || p.auto?.place || null;
      const ex = byHost.get(p.host);
      if (ex) {
        if (ex.lat == null && pLat != null) { ex.lat = pLat; ex.lon = pLon; }
        if (!ex.place && pPlace) ex.place = pPlace;
        if (!ex.primary) ex.statusLabel = 'peer';
      } else {
        byHost.set(p.host, {
          host: p.host,
          lat: pLat,
          lon: pLon,
          place: pPlace,
          status: 'ok',
          statusLabel: 'peer',
          link: `/hosts/${encodeURIComponent(p.host)}`,
        });
      }
    }
    return Array.from(byHost.values());
  }, [hosts, self, peers]);

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Fleet map</h1>
      <p className="subtitle">
        Where your VPS and federated peers are. The main othoni server is the
        <span style={{ color: 'var(--accent, #fbbf24)' }}> ★</span>; set a
        location per host or peer under <strong>Settings</strong>.
      </p>
      {err && <div className="error">{err}</div>}
      <FleetMap nodes={nodes} />
    </div>
  );
}
