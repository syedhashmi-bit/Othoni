import React, { useMemo, useState } from 'react';
import { formatRate, formatBytes } from './utils';

// Build a smooth-ish polyline path (linear segments — keeps things crisp at
// any zoom and avoids the wobble of cardinal splines on noisy data).
function buildPath(points, x, y) {
  if (!points.length) return '';
  let d = `M ${x(points[0].t)} ${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${x(points[i].t)} ${y(points[i].v)}`;
  }
  return d;
}

function domain(points, fixedMax) {
  if (!points.length) return { min: 0, max: fixedMax || 1 };
  let min = points[0].v;
  let max = points[0].v;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (fixedMax != null) return { min: 0, max: Math.max(fixedMax, max) };
  // Add a touch of headroom so the line never hugs the top.
  const span = max - min;
  const pad = span === 0 ? Math.abs(max) * 0.1 || 1 : span * 0.1;
  return { min: Math.max(0, min - pad), max: max + pad };
}

export function Sparkline({
  points = [],
  height = 32,
  color = 'var(--accent)',
  fixedMax,
  showStats = false,
  format = 'number',
}) {
  const width = 120; // viewBox width — scales to the container

  // Stats are derived from the raw points (not padded domain) so they reflect
  // the actual observed min / avg / max values.
  let pMin = null, pMax = null, pAvg = null;
  if (points.length) {
    pMin = points[0].v; pMax = points[0].v;
    let sum = 0;
    for (const p of points) {
      if (p.v < pMin) pMin = p.v;
      if (p.v > pMax) pMax = p.v;
      sum += p.v;
    }
    pAvg = sum / points.length;
  }

  const fmtFn = fmt[format] || fmt.number;
  const statsRow = showStats ? (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 4,
        fontSize: 11,
        color: 'var(--text-dim)',
      }}
    >
      <span>min <span style={{ color: 'var(--text-muted)' }}>{pMin != null ? fmtFn(pMin) : '—'}</span></span>
      <span>avg <span style={{ color: 'var(--text-muted)' }}>{pAvg != null ? fmtFn(pAvg) : '—'}</span></span>
      <span>max <span style={{ color: 'var(--text-muted)' }}>{pMax != null ? fmtFn(pMax) : '—'}</span></span>
    </div>
  ) : null;

  if (points.length < 2) {
    const empty = (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="var(--border)" strokeWidth="1" />
      </svg>
    );
    return showStats ? <div>{empty}{statsRow}</div> : empty;
  }
  const t0 = points[0].t;
  const tN = points[points.length - 1].t;
  const { min, max } = domain(points, fixedMax);
  const span = max - min || 1;
  const x = (t) => ((t - t0) / Math.max(1, tN - t0)) * width;
  const y = (v) => height - ((v - min) / span) * (height - 2) - 1;
  const linePath = buildPath(points, x, y);
  const areaPath = `${linePath} L ${x(tN)} ${height} L ${x(t0)} ${height} Z`;
  const id = `spark-${Math.random().toString(36).slice(2, 8)}`;
  const svg = (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showStats && pMin !== pMax && (
        <>
          <line
            x1="0" x2={width} y1={y(pMax)} y2={y(pMax)}
            stroke={color} strokeOpacity="0.35"
            strokeDasharray="2 2" strokeWidth="0.75"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1="0" x2={width} y1={y(pMin)} y2={y(pMin)}
            stroke="var(--text-dim)" strokeOpacity="0.5"
            strokeDasharray="2 2" strokeWidth="0.75"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
      <path className="spark-area" d={areaPath} fill={`url(#${id})`} />
      <path className="spark-line" d={linePath} stroke={color} strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
  return showStats ? <div>{svg}{statsRow}</div> : svg;
}

const fmt = {
  percent: (v) => `${v.toFixed(1)}%`,
  rate: (v) => formatRate(v),
  bytes: (v) => formatBytes(v),
  number: (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2)),
};

function niceTicks(min, max, count = 4) {
  if (max === min) return [min];
  const step = (max - min) / count;
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + step * i);
  return ticks;
}

function formatTime(ms, range) {
  const d = new Date(ms);
  if (range === '24h' || range === '6h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LineChart({
  points = [],
  height = 220,
  color = 'var(--accent)',
  format = 'percent',
  range = '1h',
  fixedMax,
  enableBrush = false,
}) {
  const [hover, setHover] = useState(null);
  const [box, setBox] = useState({ w: 600 });
  const brush = useBrush();

  const fmtFn = fmt[format] || fmt.number;
  const padding = { l: 52, r: 12, t: 14, b: 24 };

  const ref = (el) => {
    if (el && el.clientWidth && el.clientWidth !== box.w) {
      setBox({ w: el.clientWidth });
    }
  };

  const w = box.w;
  const h = height;

  const viewPoints = useMemo(
    () => (enableBrush ? filterToZoom(points, brush.zoom) : points),
    [points, brush.zoom, enableBrush]
  );

  const t0 = viewPoints[0]?.t;
  const tN = viewPoints[viewPoints.length - 1]?.t;
  const { min, max } = useMemo(() => domain(viewPoints, fixedMax), [viewPoints, fixedMax]);
  const xRange = Math.max(1, tN - t0);
  const x = (t) => padding.l + ((t - t0) / xRange) * (w - padding.l - padding.r);
  const y = (v) => padding.t + (1 - (v - min) / Math.max(1e-9, max - min)) * (h - padding.t - padding.b);
  const pxToT = (px) => {
    const inner = w - padding.l - padding.r;
    const clamped = Math.max(padding.l, Math.min(w - padding.r, px));
    return t0 + ((clamped - padding.l) / inner) * xRange;
  };

  const linePath = buildPath(viewPoints, x, y);
  const areaPath = viewPoints.length
    ? `${linePath} L ${x(tN)} ${h - padding.b} L ${x(t0)} ${h - padding.b} Z`
    : '';
  const yTicks = niceTicks(min, max, 4);
  const xTickCount = 5;
  const xTicks = viewPoints.length
    ? Array.from({ length: xTickCount }, (_, i) => t0 + (xRange * i) / (xTickCount - 1))
    : [];
  const id = `area-${Math.random().toString(36).slice(2, 8)}`;

  function onMove(e) {
    if (!viewPoints.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (enableBrush && brush.drag) {
      brush.extendDrag(px);
      return;
    }
    if (px < padding.l || px > w - padding.r) {
      setHover(null);
      return;
    }
    const targetT = t0 + ((px - padding.l) / (w - padding.l - padding.r)) * xRange;
    let nearest = viewPoints[0];
    let bestDist = Math.abs(viewPoints[0].t - targetT);
    for (const p of viewPoints) {
      const d = Math.abs(p.t - targetT);
      if (d < bestDist) { bestDist = d; nearest = p; }
    }
    setHover(nearest);
  }

  function onDown(e) {
    if (!enableBrush || !viewPoints.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < padding.l || px > w - padding.r) return;
    setHover(null);
    brush.beginDrag(px);
  }

  function onUp() {
    if (!enableBrush) return;
    brush.commitDrag(pxToT);
  }

  function onLeave() {
    setHover(null);
    if (enableBrush) brush.cancelDrag();
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={w}
        height={h}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onMouseLeave={onLeave}
        style={{ display: 'block', cursor: enableBrush ? (brush.drag ? 'ew-resize' : 'crosshair') : 'default', userSelect: 'none' }}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* y-axis grid + labels */}
        {yTicks.map((v, i) => {
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={padding.l} x2={w - padding.r} y1={yy} y2={yy} stroke="var(--border)" strokeDasharray="2 4" />
              <text x={padding.l - 8} y={yy + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
                {fmtFn(v)}
              </text>
            </g>
          );
        })}

        {/* x-axis labels */}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={h - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize="11"
            fill="var(--text-muted)"
          >
            {formatTime(t, range)}
          </text>
        ))}

        {viewPoints.length > 1 && (
          <>
            <path d={areaPath} fill={`url(#${id})`} />
            <path d={linePath} stroke={color} strokeWidth="1.75" fill="none" />
          </>
        )}

        {hover && !brush.drag && (
          <>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={padding.t} y2={h - padding.b} stroke={color} strokeOpacity="0.4" />
            <circle cx={x(hover.t)} cy={y(hover.v)} r="3.5" fill={color} stroke="var(--bg-card)" strokeWidth="2" />
          </>
        )}

        {enableBrush && brush.drag && (
          <rect
            x={Math.min(brush.drag.startPx, brush.drag.currentPx)}
            y={padding.t}
            width={Math.abs(brush.drag.currentPx - brush.drag.startPx)}
            height={h - padding.t - padding.b}
            fill={color}
            fillOpacity="0.12"
            stroke={color}
            strokeOpacity="0.5"
            strokeWidth="1"
          />
        )}
      </svg>
      {hover && !brush.drag && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(w - 140, Math.max(8, x(hover.t) + 10)),
            top: y(hover.v) - 28,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 12,
            color: 'var(--text)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 600 }}>{fmtFn(hover.v)}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{formatTime(hover.t, range)}</div>
        </div>
      )}
      {enableBrush && brush.zoom && (
        <ResetZoomButton onClick={() => brush.setZoom(null)} />
      )}
      {!viewPoints.length && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--text-muted)',
            fontSize: 13,
          }}
        >
          {brush.zoom ? 'no samples in selected range' : 'collecting samples…'}
        </div>
      )}
    </div>
  );
}

// Hook so charts re-render on container resize.
function useContainerWidth(initial = 600) {
  const [w, setW] = useState(initial);
  const ref = (el) => {
    if (el && el.clientWidth && el.clientWidth !== w) setW(el.clientWidth);
  };
  return [w, ref];
}

// Brush + zoom state shared by LineChart and MultiLineChart. Owns:
//   - committed `zoom` window ({from, to} timestamps), null when at full range
//   - in-flight `drag` ({startPx, currentPx}) during a click-drag selection
// Charts call beginDrag/extendDrag/commitDrag from their own mouse handlers
// so they can coordinate with hover (suppress hover while dragging).
function useBrush() {
  const [zoom, setZoom] = useState(null);
  const [drag, setDrag] = useState(null);
  return {
    zoom,
    setZoom,
    drag,
    beginDrag: (px) => setDrag({ startPx: px, currentPx: px }),
    extendDrag: (px) => setDrag((d) => (d ? { ...d, currentPx: px } : null)),
    cancelDrag: () => setDrag(null),
    // Returns the new zoom window if the drag was a real selection, else null.
    commitDrag: (pxToT) => {
      let next = null;
      setDrag((d) => {
        if (d && Math.abs(d.currentPx - d.startPx) >= 5) {
          const a = pxToT(Math.min(d.startPx, d.currentPx));
          const b = pxToT(Math.max(d.startPx, d.currentPx));
          if (b - a > 1000) {
            next = { from: a, to: b };
            setZoom(next);
          }
        }
        return null;
      });
      return next;
    },
  };
}

// Filter points to a [from, to] window (inclusive). Used by zoom.
function filterToZoom(points, zoom) {
  if (!zoom) return points;
  return points.filter((p) => p.t >= zoom.from && p.t <= zoom.to);
}

// Tiny "× reset zoom" pill rendered top-right when a chart is zoomed in.
function ResetZoomButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        background: 'var(--bg-elevated)',
        color: 'var(--text-muted)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        font: 'inherit',
        fontVariantNumeric: 'tabular-nums',
      }}
      title="Reset zoom"
    >
      × reset zoom
    </button>
  );
}

// Several series on the same axes (e.g. CPU + Memory together, or read+write
// disk I/O). Each series: { name, points: [{t,v}], color }.
export function MultiLineChart({
  series = [],
  height = 220,
  format = 'percent',
  range = '1h',
  fixedMax,
  showLegend = true,
  enableBrush = false,
}) {
  const [w, ref] = useContainerWidth();
  const [hover, setHover] = useState(null);
  const brush = useBrush();
  const fmtFn = fmt[format] || fmt.number;
  const padding = { l: 56, r: 12, t: 14, b: 24 };
  const h = height;

  const viewSeries = enableBrush
    ? series.map((s) => ({ ...s, points: filterToZoom(s.points, brush.zoom) }))
    : series;

  const allPoints = viewSeries.flatMap((s) => s.points);
  if (!allPoints.length) {
    return (
      <div ref={ref} style={{ position: 'relative', width: '100%', height }}>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {brush.zoom ? 'no samples in selected range' : 'collecting samples…'}
        </div>
        {enableBrush && brush.zoom && (
          <ResetZoomButton onClick={() => brush.setZoom(null)} />
        )}
      </div>
    );
  }

  let t0 = Infinity, tN = -Infinity;
  for (const p of allPoints) { if (p.t < t0) t0 = p.t; if (p.t > tN) tN = p.t; }
  const dom = domain(allPoints, fixedMax);
  const xRange = Math.max(1, tN - t0);
  const x = (t) => padding.l + ((t - t0) / xRange) * (w - padding.l - padding.r);
  const y = (v) => padding.t + (1 - (v - dom.min) / Math.max(1e-9, dom.max - dom.min)) * (h - padding.t - padding.b);
  const pxToT = (px) => {
    const inner = w - padding.l - padding.r;
    const clamped = Math.max(padding.l, Math.min(w - padding.r, px));
    return t0 + ((clamped - padding.l) / inner) * xRange;
  };

  const yTicks = niceTicks(dom.min, dom.max, 4);
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (xRange * i) / (xTickCount - 1));

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (enableBrush && brush.drag) { brush.extendDrag(px); return; }
    if (px < padding.l || px > w - padding.r) { setHover(null); return; }
    const targetT = t0 + ((px - padding.l) / (w - padding.l - padding.r)) * xRange;
    setHover({ t: targetT });
  }

  function onDown(e) {
    if (!enableBrush) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < padding.l || px > w - padding.r) return;
    setHover(null);
    brush.beginDrag(px);
  }

  function onUp() {
    if (!enableBrush) return;
    brush.commitDrag(pxToT);
  }

  function onLeave() {
    setHover(null);
    if (enableBrush) brush.cancelDrag();
  }

  // For the tooltip: pick the nearest point in each series to hover.t
  const hovered = hover && !brush.drag
    ? viewSeries.map((s) => {
        if (!s.points.length) return null;
        let best = s.points[0], bestD = Math.abs(s.points[0].t - hover.t);
        for (const p of s.points) { const d = Math.abs(p.t - hover.t); if (d < bestD) { bestD = d; best = p; } }
        return { name: s.name, color: s.color, point: best };
      }).filter(Boolean)
    : [];

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={w}
        height={h}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onMouseLeave={onLeave}
        style={{ display: 'block', cursor: enableBrush ? (brush.drag ? 'ew-resize' : 'crosshair') : 'default', userSelect: 'none' }}
      >
        {yTicks.map((v, i) => {
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={padding.l} x2={w - padding.r} y1={yy} y2={yy} stroke="var(--border)" strokeDasharray="2 4" />
              <text x={padding.l - 8} y={yy + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{fmtFn(v)}</text>
            </g>
          );
        })}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={h - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize="11" fill="var(--text-muted)">
            {formatTime(t, range)}
          </text>
        ))}

        {viewSeries.map((s, i) => (
          <path
            key={i}
            d={buildPath(s.points, x, y)}
            stroke={s.color}
            strokeWidth="1.75"
            fill="none"
            opacity={s.points.length ? 1 : 0}
          />
        ))}

        {hover && !brush.drag && hovered.map((h, i) => (
          <circle key={i} cx={x(h.point.t)} cy={y(h.point.v)} r="3.5" fill={h.color} stroke="var(--bg-card)" strokeWidth="2" />
        ))}
        {hover && !brush.drag && hovered.length > 0 && (
          <line x1={x(hovered[0].point.t)} x2={x(hovered[0].point.t)} y1={padding.t} y2={h - padding.b} stroke="var(--text-muted)" strokeOpacity="0.4" />
        )}

        {enableBrush && brush.drag && (
          <rect
            x={Math.min(brush.drag.startPx, brush.drag.currentPx)}
            y={padding.t}
            width={Math.abs(brush.drag.currentPx - brush.drag.startPx)}
            height={h - padding.t - padding.b}
            fill="var(--accent)"
            fillOpacity="0.12"
            stroke="var(--accent)"
            strokeOpacity="0.5"
            strokeWidth="1"
          />
        )}
      </svg>

      {showLegend && (
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-muted)', padding: '6px 0 0 56px', flexWrap: 'wrap' }}>
          {series.map((s) => (
            <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}

      {hover && !brush.drag && hovered.length > 0 && (
        <div style={{
          position: 'absolute',
          left: Math.min(w - 180, Math.max(8, x(hovered[0].point.t) + 10)),
          top: padding.t + 4,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 12,
          color: 'var(--text)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>{formatTime(hovered[0].point.t, range)}</div>
          {hovered.map((h) => (
            <div key={h.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: h.color }} />
              <span style={{ color: 'var(--text-muted)', minWidth: 60 }}>{h.name}</span>
              <strong>{fmtFn(h.point.v)}</strong>
            </div>
          ))}
        </div>
      )}

      {enableBrush && brush.zoom && (
        <ResetZoomButton onClick={() => brush.setZoom(null)} />
      )}
    </div>
  );
}

// Stacked areas — the values of all series at each t are stacked top-of-each-other.
// Useful when the series sum to a meaningful total (CPU breakdown ≈ 100%, or
// memory regions adding to total RAM).
//
// All series must share the same timestamps; we align by index.
export function StackedAreaChart({
  series = [],
  height = 220,
  format = 'percent',
  range = '1h',
  fixedMax,
  showLegend = true,
  enableBrush = false,
}) {
  const [w, ref] = useContainerWidth();
  const [hover, setHover] = useState(null);
  const brush = useBrush();
  const fmtFn = fmt[format] || fmt.number;
  const padding = { l: 56, r: 12, t: 14, b: 24 };
  const h = height;

  // Apply zoom filter, then drop empty series. Use the longest as anchor.
  const zoomed = enableBrush
    ? series.map((s) => ({ ...s, points: filterToZoom(s.points || [], brush.zoom) }))
    : series;
  const filled = zoomed.filter((s) => s.points && s.points.length);
  if (!filled.length) {
    return (
      <div ref={ref} style={{ position: 'relative', width: '100%', height }}>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {brush.zoom ? 'no samples in selected range' : 'collecting samples…'}
        </div>
        {enableBrush && brush.zoom && (
          <ResetZoomButton onClick={() => brush.setZoom(null)} />
        )}
      </div>
    );
  }

  const anchor = filled.reduce((best, s) => (s.points.length > best.points.length ? s : best), filled[0]);
  const t0 = anchor.points[0].t;
  const tN = anchor.points[anchor.points.length - 1].t;
  const xRange = Math.max(1, tN - t0);
  const pxToT = (px) => {
    const inner = w - padding.l - padding.r;
    const clamped = Math.max(padding.l, Math.min(w - padding.r, px));
    return t0 + ((clamped - padding.l) / inner) * xRange;
  };

  // Build a value-by-timestamp lookup for each series by nearest-t (for charts
  // where downsampling has slightly differing buckets across series, this is
  // robust enough).
  function valueAt(s, t) {
    if (!s.points.length) return 0;
    let best = s.points[0], bestD = Math.abs(s.points[0].t - t);
    for (const p of s.points) { const d = Math.abs(p.t - t); if (d < bestD) { bestD = d; best = p; } }
    return best.v;
  }

  // Compute stack tops at each anchor timestamp.
  const stack = anchor.points.map((p) => {
    const t = p.t;
    let cum = 0;
    const layers = filled.map((s) => {
      const v = valueAt(s, t);
      const top = cum + v;
      const layer = { name: s.name, color: s.color, t, base: cum, top, value: v };
      cum = top;
      return layer;
    });
    return { t, total: cum, layers };
  });

  // Domain — max stack height across all timestamps, or fixedMax.
  let stackMax = 0;
  for (const s of stack) if (s.total > stackMax) stackMax = s.total;
  const dom = { min: 0, max: fixedMax != null ? Math.max(fixedMax, stackMax) : stackMax || 1 };

  const x = (t) => padding.l + ((t - t0) / xRange) * (w - padding.l - padding.r);
  const y = (v) => padding.t + (1 - (v - dom.min) / Math.max(1e-9, dom.max - dom.min)) * (h - padding.t - padding.b);

  // Build one polygon per layer (top edge, then bottom edge in reverse).
  const layerPaths = filled.map((s, idx) => {
    const tops = stack.map((sp) => sp.layers[idx]);
    let d = `M ${x(tops[0].t)} ${y(tops[0].top)}`;
    for (let i = 1; i < tops.length; i++) d += ` L ${x(tops[i].t)} ${y(tops[i].top)}`;
    for (let i = tops.length - 1; i >= 0; i--) d += ` L ${x(tops[i].t)} ${y(tops[i].base)}`;
    d += ' Z';
    return { d, color: s.color, name: s.name };
  });

  const yTicks = niceTicks(dom.min, dom.max, 4);
  const xTickCount = 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (xRange * i) / (xTickCount - 1));

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (enableBrush && brush.drag) { brush.extendDrag(px); return; }
    if (px < padding.l || px > w - padding.r) { setHover(null); return; }
    const targetT = t0 + ((px - padding.l) / (w - padding.l - padding.r)) * xRange;
    let nearest = stack[0], bestD = Math.abs(stack[0].t - targetT);
    for (const sp of stack) { const d = Math.abs(sp.t - targetT); if (d < bestD) { bestD = d; nearest = sp; } }
    setHover(nearest);
  }

  function onDown(e) {
    if (!enableBrush) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < padding.l || px > w - padding.r) return;
    setHover(null);
    brush.beginDrag(px);
  }

  function onUp() {
    if (!enableBrush) return;
    brush.commitDrag(pxToT);
  }

  function onLeave() {
    setHover(null);
    if (enableBrush) brush.cancelDrag();
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={w}
        height={h}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={onUp}
        onMouseLeave={onLeave}
        style={{ display: 'block', cursor: enableBrush ? (brush.drag ? 'ew-resize' : 'crosshair') : 'default', userSelect: 'none' }}
      >
        {yTicks.map((v, i) => {
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={padding.l} x2={w - padding.r} y1={yy} y2={yy} stroke="var(--border)" strokeDasharray="2 4" />
              <text x={padding.l - 8} y={yy + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{fmtFn(v)}</text>
            </g>
          );
        })}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={h - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize="11" fill="var(--text-muted)">
            {formatTime(t, range)}
          </text>
        ))}

        {layerPaths.map((p, i) => (
          <path key={i} d={p.d} fill={p.color} fillOpacity="0.65" stroke={p.color} strokeWidth="0.75" />
        ))}

        {hover && !brush.drag && (
          <line x1={x(hover.t)} x2={x(hover.t)} y1={padding.t} y2={h - padding.b} stroke="var(--text-muted)" strokeOpacity="0.4" />
        )}

        {enableBrush && brush.drag && (
          <rect
            x={Math.min(brush.drag.startPx, brush.drag.currentPx)}
            y={padding.t}
            width={Math.abs(brush.drag.currentPx - brush.drag.startPx)}
            height={h - padding.t - padding.b}
            fill="var(--accent)"
            fillOpacity="0.12"
            stroke="var(--accent)"
            strokeOpacity="0.5"
            strokeWidth="1"
          />
        )}
      </svg>

      {showLegend && (
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-muted)', padding: '6px 0 0 56px', flexWrap: 'wrap' }}>
          {filled.map((s) => (
            <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, opacity: 0.85 }} />
              {s.name}
            </span>
          ))}
        </div>
      )}

      {hover && !brush.drag && (
        <div style={{
          position: 'absolute',
          left: Math.min(w - 180, Math.max(8, x(hover.t) + 10)),
          top: padding.t + 4,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 12,
          color: 'var(--text)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 }}>{formatTime(hover.t, range)}</div>
          {hover.layers.map((l) => (
            <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: l.color }} />
              <span style={{ color: 'var(--text-muted)', minWidth: 60 }}>{l.name}</span>
              <strong>{fmtFn(l.value)}</strong>
            </div>
          ))}
        </div>
      )}

      {enableBrush && brush.zoom && (
        <ResetZoomButton onClick={() => brush.setZoom(null)} />
      )}
    </div>
  );
}

// Small grid of vertical bars — one per CPU core. Each shows the current
// load. Cores: [{ load: 0..100 }].
// v0.45 — Per-core CPU heatmap. `cores` shape:
//   [{ core: 0, points: [{ t, v }, ...] }, ...]
// where v is a 0..100 percent. Rows = cores, columns = time buckets,
// cell hue ramps cool→hot. Pure SVG, no library. Hover shows a tooltip.
export function Heatmap({
  cores = [],
  bucketMs,
  from,
  to,
  cellH = 16,
  gap = 1,
  rangeLabel = '',
}) {
  const [hover, setHover] = useState(null);
  const w = useContainerWidth(800);

  if (!cores.length) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No per-core data in this range.</div>;
  }

  // Build a fixed-width column grid spanning the requested range so
  // gaps in the data render as empty cells. Each bucket is one
  // column; the cell positions are derived from (t - from) / bucketMs.
  const span = Math.max(1, (to || Date.now()) - (from || Date.now()));
  const nCols = Math.max(1, Math.ceil(span / Math.max(1000, bucketMs || 60000)));
  // Reserve room on the left for the core labels.
  const labelW = 32;
  const gridW = Math.max(120, w - labelW);
  const cellW = Math.max(1.5, (gridW - (nCols - 1) * gap) / nCols);
  const rows = cores.length;
  const height = rows * cellH + (rows - 1) * gap;

  function colorFor(v) {
    if (v == null || !Number.isFinite(v)) return 'var(--bg-card-2)';
    // Three stops: cool (0–60) → warn (75) → crit (90+). Linear hue
    // ramp between them through HSL so the gradient stays perceptually
    // smooth on dark theme. Saturation/lightness fixed.
    const x = Math.max(0, Math.min(100, v));
    // 0 → 220 (cool blue), 60 → 200, 75 → 40 (amber), 100 → 0 (red)
    let h;
    if (x <= 60) h = 220 - (220 - 200) * (x / 60);          // 220 → 200
    else if (x <= 75) h = 200 - (200 - 40) * ((x - 60) / 15); // 200 → 40
    else h = 40 - 40 * ((x - 75) / 25);                       // 40 → 0
    const s = 70;
    const l = 32 + (x / 100) * 18; // 32% → 50% lightness
    return `hsl(${h.toFixed(0)} ${s}% ${l.toFixed(0)}%)`;
  }

  return (
    <div style={{ width: '100%', position: 'relative' }}>
      <svg
        viewBox={`0 0 ${labelW + gridW} ${height}`}
        width="100%"
        height={height}
        style={{ display: 'block' }}
        onMouseLeave={() => setHover(null)}
      >
        {cores.map((c, ri) => {
          const y = ri * (cellH + gap);
          // Bin points by column index.
          const valByCol = new Array(nCols).fill(null);
          for (const p of c.points || []) {
            const col = Math.floor((p.t - from) / bucketMs);
            if (col >= 0 && col < nCols) valByCol[col] = p.v;
          }
          return (
            <g key={c.core ?? ri}>
              <text
                x={labelW - 6}
                y={y + cellH / 2 + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="var(--text-muted)"
                fontFamily="ui-monospace, SF Mono, monospace"
              >
                c{c.core ?? ri}
              </text>
              {valByCol.map((v, ci) => (
                <rect
                  key={ci}
                  x={labelW + ci * (cellW + gap)}
                  y={y}
                  width={cellW}
                  height={cellH}
                  fill={colorFor(v)}
                  onMouseEnter={() => setHover({ core: c.core ?? ri, col: ci, v, t: from + ci * bucketMs })}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          style={{
            position: 'absolute',
            right: 6,
            top: 0,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            fontSize: 11,
            color: 'var(--text)',
            pointerEvents: 'none',
            fontFamily: 'ui-monospace, SF Mono, monospace',
            whiteSpace: 'nowrap',
          }}
        >
          core c{hover.core} ·{' '}
          {hover.v == null ? '—' : `${hover.v.toFixed(1)}%`} ·{' '}
          {new Date(hover.t).toLocaleTimeString([], { hour12: false })}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 4,
          fontSize: 10,
          color: 'var(--text-dim)',
        }}
      >
        <span>{from ? new Date(from).toLocaleTimeString([], { hour12: false }) : ''}</span>
        <span>{rangeLabel}</span>
        <span>{to ? new Date(to).toLocaleTimeString([], { hour12: false }) : 'now'}</span>
      </div>
    </div>
  );
}

export function CoreGrid({ cores = [] }) {
  if (!cores.length) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No core data.</div>;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${cores.length > 16 ? 38 : 56}px, 1fr))`,
        gap: 10,
      }}
    >
      {cores.map((c, i) => {
        const v = Math.max(0, Math.min(100, c.load || 0));
        const color = v >= 90 ? 'var(--crit)' : v >= 75 ? 'var(--warn)' : 'var(--accent)';
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: 56,
                background: 'var(--bg-hover)',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: `${v}%`,
                  background: color,
                  transition: 'height 0.4s ease, background 0.3s',
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--text)' }}>{v.toFixed(0)}%</span>
              <span style={{ marginLeft: 4 }}>c{i}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
