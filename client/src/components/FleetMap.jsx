import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LAND_PATHS, WORLD_VIEWBOX, project } from '../lib/worldMap.js';

// Status → dot color. Uses theme vars when present, falls back to sane
// defaults so the map renders correctly regardless of theme wiring.
const STATUS_COLOR = {
  ok:   'var(--ok, #34d399)',
  warn: 'var(--warn, #fbbf24)',
  crit: 'var(--crit, #f87171)',
  idle: 'var(--muted-fg, #64748b)',
};

// Longitude/latitude graticule every 30° — drawn faintly for orientation.
const GRATICULE = [];
for (let lon = -150; lon <= 150; lon += 30) GRATICULE.push(['v', lon]);
for (let lat = -60; lat <= 60; lat += 30) GRATICULE.push(['h', lat]);

export default function FleetMap({ nodes = [] }) {
  const navigate = useNavigate();
  const placed = nodes.filter((n) => n.lat != null && n.lon != null);
  const unplaced = nodes.filter((n) => n.lat == null || n.lon == null);

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="card-title">Fleet map</div>
          <div className="card-sub" style={{ fontSize: 11 }}>
            {placed.length} of {nodes.length} located · set a location per host
            or peer in <strong>Settings</strong>
          </div>
        </div>
      </div>

      <svg
        viewBox={WORLD_VIEWBOX}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: 'auto', maxHeight: 360, display: 'block', marginTop: 8 }}
        role="img"
        aria-label="World map of fleet hosts"
      >
        <rect x="0" y="0" width="360" height="180" fill="var(--bg-2, #0f172a)" rx="2" />

        {GRATICULE.map(([dir, v], i) =>
          dir === 'v' ? (
            <line key={`g${i}`} x1={v + 180} y1="0" x2={v + 180} y2="180"
              stroke="var(--border, #1e293b)" strokeWidth="0.2" />
          ) : (
            <line key={`g${i}`} x1="0" y1={90 - v} x2="360" y2={90 - v}
              stroke="var(--border, #1e293b)" strokeWidth="0.2" />
          )
        )}

        {LAND_PATHS.map((d, i) => (
          <path key={`l${i}`} d={d}
            fill="var(--surface-2, #1e293b)"
            stroke="var(--border, #334155)" strokeWidth="0.3"
            strokeLinejoin="round" opacity="0.9" />
        ))}

        {placed.map((n) => {
          const [x, y] = project(n.lon, n.lat);
          const color = STATUS_COLOR[n.status] || STATUS_COLOR.idle;
          return (
            <g
              key={n.host}
              transform={`translate(${x} ${y})`}
              style={{ cursor: n.link ? 'pointer' : 'default' }}
              onClick={() => n.link && navigate(n.link)}
            >
              <title>{`${n.host}${n.place ? ` — ${n.place}` : ''} · ${n.statusLabel || n.status}`}</title>
              <circle r="5" fill={color} opacity="0.18" />
              <circle r="2.4" fill={color} stroke="var(--bg, #020617)" strokeWidth="0.5" />
            </g>
          );
        })}
      </svg>

      {unplaced.length > 0 && (
        <div className="dim" style={{ fontSize: 11, marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span>Unplaced:</span>
          {unplaced.map((n) => (
            <span key={n.host} className="chip dim" style={{ fontSize: 10 }}>{n.host}</span>
          ))}
        </div>
      )}
    </div>
  );
}
