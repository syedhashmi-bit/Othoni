import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LAND_PATHS, COUNTRIES, project } from '../lib/worldMap.js';

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

// Five-point star path centered on (0,0), used to mark the main othoni server.
function starPath(outer, inner) {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((-90 + i * 36) * Math.PI) / 180;
    d += (i === 0 ? 'M' : 'L') + (r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2);
  }
  return d + 'Z';
}
const STAR_D = starPath(5.5, 2.2);
const STAR_COLOR = 'var(--accent, #fbbf24)';

const FULL = { x: 0, y: 0, w: 360, h: 180 };
const MIN_W = 40; // max zoom ≈ 9×

// Keep the aspect 2:1 and don't let the view pan off the world rectangle.
function clampView(v) {
  const w = Math.min(360, Math.max(MIN_W, v.w));
  const h = w / 2;
  return {
    w, h,
    x: Math.min(Math.max(v.x, 0), 360 - w),
    y: Math.min(Math.max(v.y, 0), 180 - h),
  };
}

export default function FleetMap({ nodes = [] }) {
  const navigate = useNavigate();
  const svgRef = useRef(null);
  const drag = useRef(null);
  const movedRef = useRef(false);
  const [view, setView] = useState(FULL);

  const placed = nodes.filter((n) => n.lat != null && n.lon != null);
  const unplaced = nodes.filter((n) => n.lat == null || n.lon == null);
  const zoomed = view.w < 360 - 0.5;
  const k = view.w / 360; // counter-scale so markers + labels hold screen size

  // Wheel zoom centered on the cursor. Attached non-passively so we can
  // preventDefault (stops the page from scrolling while zooming the map).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    function onWheel(e) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      setView((v) => {
        const ux = v.x + px * v.w;
        const uy = v.y + py * v.h;
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        const w = Math.min(360, Math.max(MIN_W, v.w * factor));
        const h = w / 2;
        return clampView({ x: ux - px * w, y: uy - py * h, w, h });
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(e) {
    movedRef.current = false;
    drag.current = { startX: e.clientX, startY: e.clientY, view };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) movedRef.current = true;
    const dx = ((e.clientX - d.startX) * d.view.w) / rect.width;
    const dy = ((e.clientY - d.startY) * d.view.h) / rect.height;
    setView(clampView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy }));
  }
  function onPointerUp(e) {
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    drag.current = null;
  }
  function nodeClick(n) {
    if (movedRef.current) return; // it was a pan, not a click
    if (n.link) navigate(n.link);
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="card-title">Fleet map</div>
          <div className="card-sub" style={{ fontSize: 11 }}>
            {placed.length} of {nodes.length} located · scroll to zoom, drag to pan
          </div>
        </div>
      </div>

      <div style={{ position: 'relative', marginTop: 8 }}>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            width: '100%', height: 'auto', maxHeight: 420, display: 'block',
            touchAction: 'none', cursor: drag.current ? 'grabbing' : 'grab',
            background: 'var(--bg-2, #0f172a)', borderRadius: 4,
          }}
          role="img"
          aria-label="World map of fleet hosts"
        >
          {GRATICULE.map(([dir, v], i) =>
            dir === 'v' ? (
              <line key={`g${i}`} x1={v + 180} y1="0" x2={v + 180} y2="180"
                stroke="var(--border, #1e293b)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
            ) : (
              <line key={`g${i}`} x1="0" y1={90 - v} x2="360" y2={90 - v}
                stroke="var(--border, #1e293b)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
            )
          )}

          {LAND_PATHS.map((d, i) => (
            <path key={`l${i}`} d={d}
              fill="var(--surface-2, #1e293b)"
              stroke="var(--border, #334155)" strokeWidth="1" vectorEffect="non-scaling-stroke"
              strokeLinejoin="round" opacity="0.9" />
          ))}

          {COUNTRIES.map((c) => {
            const [x, y] = project(c.lon, c.lat);
            return (
              <text
                key={c.name}
                transform={`translate(${x} ${y}) scale(${k})`}
                textAnchor="middle"
                fontSize="2.8"
                fill="var(--muted-fg, #94a3b8)"
                opacity="0.65"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {c.name}
              </text>
            );
          })}

          {placed.map((n) => {
            const [x, y] = project(n.lon, n.lat);
            const color = STATUS_COLOR[n.status] || STATUS_COLOR.idle;
            return (
              <g
                key={n.host}
                transform={`translate(${x} ${y}) scale(${k})`}
                style={{ cursor: n.link ? 'pointer' : 'default' }}
                onClick={() => nodeClick(n)}
              >
                <title>{`${n.host}${n.place ? ` — ${n.place}` : ''} · ${n.statusLabel || n.status}`}</title>
                {n.primary ? (
                  <>
                    <circle r="7" fill={STAR_COLOR} opacity="0.2" />
                    <path d={STAR_D} fill={STAR_COLOR} stroke="var(--bg, #020617)" strokeWidth="0.5" />
                  </>
                ) : (
                  <>
                    <circle r="5" fill={color} opacity="0.18" />
                    <circle r="2.4" fill={color} stroke="var(--bg, #020617)" strokeWidth="0.5" />
                  </>
                )}
              </g>
            );
          })}
        </svg>

        {zoomed && (
          <button
            type="button"
            onClick={() => setView(FULL)}
            title="Reset zoom"
            style={{
              position: 'absolute', top: 8, right: 8, fontSize: 11, fontWeight: 600,
              padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
              color: 'var(--fg, #cbd5e1)', background: 'var(--surface-2, rgba(15,23,42,0.8))',
              border: '1px solid var(--border, rgba(255,255,255,0.12))',
            }}
          >
            Reset
          </button>
        )}
      </div>

      <div className="dim" style={{ fontSize: 11, marginTop: 8, display: 'flex', gap: 14, alignItems: 'center' }}>
        <span style={{ color: STAR_COLOR }}>★ main server</span>
        <span>● peer / host</span>
      </div>

      {unplaced.length > 0 && (
        <div className="dim" style={{ fontSize: 11, marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span>Unplaced:</span>
          {unplaced.map((n) => (
            <span key={n.host} className="chip dim" style={{ fontSize: 10 }}>{n.host}</span>
          ))}
        </div>
      )}
    </div>
  );
}
