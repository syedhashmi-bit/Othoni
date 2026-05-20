// v0.61 — pulse-line mark. Soft ring + EKG trace. The trace animates
// in a "draw → hold → wipe" sweep via CSS keyframes in styles.css
// (`.othoni-logo-pulse` and `.othoni-logo-ring`). Default state shows
// the trace fully drawn, so under `prefers-reduced-motion: reduce`
// the global animation clamp leaves a static drawn line.
//
// `pathLength="100"` normalizes stroke-dasharray math regardless of
// the SVG's actual coordinate length, so the keyframes can talk in
// units of "0–100% of the line drawn".

export function Logo({ size = 18, className }) {
  const gid = `othoni-grad-${size}`;
  const root = ['othoni-logo', className].filter(Boolean).join(' ');
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={root}
      aria-hidden="true"
      style={{ filter: 'drop-shadow(0 0 6px rgba(91,140,255,0.55))', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7aa4ff" />
          <stop offset="100%" stopColor="#4477ff" />
        </linearGradient>
      </defs>
      <circle
        className="othoni-logo-ring"
        cx="12"
        cy="12"
        r="10"
        stroke={`url(#${gid})`}
        strokeWidth="1.25"
        opacity="0.4"
      />
      <path
        className="othoni-logo-pulse"
        d="M 3.5 12 L 8 12 L 10 9 L 12 15.5 L 14 6.5 L 16 12 L 20.5 12"
        stroke={`url(#${gid})`}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength="100"
      />
    </svg>
  );
}
