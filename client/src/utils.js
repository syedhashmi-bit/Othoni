export function formatBytes(bytes, digits = 1) {
  if (bytes == null || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatRate(bps) {
  if (bps == null || isNaN(bps)) return '—';
  return `${formatBytes(bps, 1)}/s`;
}

export function formatUptime(sec) {
  if (sec == null) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function statusClass(percent) {
  if (percent == null) return '';
  if (percent >= 90) return 'crit';
  if (percent >= 75) return 'warn';
  return '';
}

export function pillClass(status) {
  switch (status) {
    case 'active':
      return 'ok';
    case 'failed':
      return 'crit';
    case 'inactive':
    case 'activating':
      return 'warn';
    case 'missing':
    default:
      return 'dim';
  }
}
