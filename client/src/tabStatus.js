import { useEffect } from 'react';

// Mirrors alert state into the browser tab so a backgrounded dashboard is
// still noticeable: "(2) Dashboard · Othoni" plus a coloured dot on the
// favicon. The base icon is the same mark as the static data: URI in
// index.html, so the two must be kept in sync.

const BASE_ICON =
  "<rect width='32' height='32' rx='6' fill='#0b0f17'/>" +
  "<circle cx='16' cy='16' r='13' fill='none' stroke='#5b8cff' stroke-width='1.5' opacity='0.4'/>" +
  "<path d='M4.5 16 L10.5 16 L13 12 L16 21 L19 9 L21.5 16 L27.5 16' fill='none' stroke='#5b8cff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>";

const DOT_COLORS = { crit: '#ef4444', warn: '#f59e0b', offline: '#8a96b0' };

function iconHref(dot) {
  const badge = dot
    ? `<circle cx='25' cy='7' r='6.5' fill='${DOT_COLORS[dot]}' stroke='#0b0f17' stroke-width='2'/>`
    : '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${BASE_ICON}${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function useTabStatus({ activeAlerts, pageLabel, offline }) {
  const count = activeAlerts.length;
  const anyCrit = activeAlerts.some((a) => a.severity === 'crit');
  const dot = count > 0 ? (anyCrit ? 'crit' : 'warn') : offline ? 'offline' : null;

  useEffect(() => {
    const prefix = count > 0 ? `(${count}) ` : offline ? 'offline · ' : '';
    document.title = `${prefix}${pageLabel ? `${pageLabel} · ` : ''}Othoni`;
  }, [count, pageLabel, offline]);

  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.setAttribute('href', iconHref(dot));
  }, [dot]);
}
