// Small monochrome icons. All 16x16 in a 24-unit viewBox so the stroke weight
// stays consistent. Color comes from currentColor so they inherit text color.

const baseProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export function IconDashboard(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
    </svg>
  );
}

export function IconHistory(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M3 13a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 8 7 8" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  );
}

export function IconStorage(props) {
  return (
    <svg {...baseProps} {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="2.5" />
      <path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5" />
      <path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" />
    </svg>
  );
}

export function IconProcesses(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 3v18" />
    </svg>
  );
}

export function IconDocker(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="11" width="3" height="3" />
      <rect x="7" y="11" width="3" height="3" />
      <rect x="11" y="11" width="3" height="3" />
      <rect x="7" y="7" width="3" height="3" />
      <rect x="11" y="7" width="3" height="3" />
      <rect x="11" y="3" width="3" height="3" />
      <path d="M2 15c2 3 6 4 10 4 7 0 11-4 12-9-2 1-4 0-5-1" />
    </svg>
  );
}

export function IconServices(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M4.2 4.2l2.1 2.1" />
      <path d="M17.7 17.7l2.1 2.1" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="M4.2 19.8l2.1-2.1" />
      <path d="M17.7 6.3l2.1-2.1" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

export function IconNetwork(props) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18" />
      <path d="M12 3a13.5 13.5 0 0 0 0 18" />
    </svg>
  );
}

export function IconSettings(props) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

// Misc icons used in cards / topbar
export function IconCpu(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v3" /><path d="M15 2v3" />
      <path d="M9 19v3" /><path d="M15 19v3" />
      <path d="M2 9h3" /><path d="M2 15h3" />
      <path d="M19 9h3" /><path d="M19 15h3" />
    </svg>
  );
}

export function IconMemory(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="6" width="18" height="12" rx="1.5" />
      <path d="M7 10v4" />
      <path d="M11 10v4" />
      <path d="M15 10v4" />
      <path d="M19 10v4" />
    </svg>
  );
}

export function IconDisk(props) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function IconClock(props) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

export function IconSignOut(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function IconActivity(props) {
  return (
    <svg {...baseProps} {...props}>
      <polyline points="2 12 6 12 9 4 15 20 18 12 22 12" />
    </svg>
  );
}

// Plug — for the Connections page (open sockets / listening ports)
export function IconConnections(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M9 2v4" />
      <path d="M15 2v4" />
      <path d="M7 6h10v5a5 5 0 0 1-5 5 5 5 0 0 1-5-5V6Z" />
      <path d="M12 16v6" />
    </svg>
  );
}

export function IconBell(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function IconAlerts(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M10.3 3.86a2 2 0 0 1 3.4 0l8.4 14.5a2 2 0 0 1-1.7 3H3.6a2 2 0 0 1-1.7-3Z" />
      <line x1="12" y1="9" x2="12" y2="14" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}

export function IconPlus(props) {
  return (
    <svg {...baseProps} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconTrash(props) {
  return (
    <svg {...baseProps} {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

// Lined document — for the Logs page
export function IconLogs(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </svg>
  );
}

// Pulse line — synthetic checks page (uptime / probe heartbeat feel)
export function IconChecks(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M3 12h3l2-6 4 12 2-6h7" />
    </svg>
  );
}

// Lightning bolt — /actions page (run history of write surface)
export function IconActions(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}

// Stack of three servers — /hosts page (multi-host overview)
export function IconHosts(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="4"  width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
      <circle cx="7" cy="6"  r="0.6" fill="currentColor" />
      <circle cx="7" cy="12" r="0.6" fill="currentColor" />
      <circle cx="7" cy="18" r="0.6" fill="currentColor" />
    </svg>
  );
}
