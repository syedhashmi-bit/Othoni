export function Logo({ size = 18, className }) {
  // Unique gradient id so multiple Logos on a page don't collide.
  const gid = `othoni-grad-${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      style={{ filter: 'drop-shadow(0 0 6px rgba(91,140,255,0.55))', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7aa4ff" />
          <stop offset="100%" stopColor="#4477ff" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" stroke={`url(#${gid})`} strokeWidth="1.25" opacity="0.28" />
      <circle cx="12" cy="12" r="6"  stroke={`url(#${gid})`} strokeWidth="1.5"  opacity="0.7" />
      <circle cx="12" cy="12" r="2.5" fill={`url(#${gid})`} />
    </svg>
  );
}
