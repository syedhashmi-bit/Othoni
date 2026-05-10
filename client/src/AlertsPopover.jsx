import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { METRICS, formatDuration } from './alerts';
import { IconBell } from './Icons.jsx';

// Pick a reasonable journalctl `since` window for the breach duration —
// always show at least 5m so transient alerts have meaningful context.
function sinceForDuration(ms) {
  const m = ms / 60_000;
  if (m <= 5) return '15m';
  if (m <= 30) return '1h';
  return '6h';
}

export function AlertBadge({ activeAlerts, onClick }) {
  const count = activeAlerts.length;
  const anyCrit = activeAlerts.some((a) => a.rule.severity === 'crit');
  const dotColor = anyCrit ? 'var(--crit)' : 'var(--warn)';
  return (
    <button
      type="button"
      className="topbar-bell"
      onClick={onClick}
      aria-label={count === 0 ? 'No active alerts' : `${count} active alert${count === 1 ? '' : 's'}`}
    >
      <IconBell />
      {count > 0 && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            right: -2,
            minWidth: 16,
            height: 16,
            padding: '0 5px',
            borderRadius: 999,
            background: dotColor,
            color: '#0b0f17',
            fontSize: 10,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: anyCrit ? '0 0 0 3px rgba(239, 68, 68, 0.2)' : '0 0 0 3px rgba(245, 158, 11, 0.2)',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function AlertsPopover({ activeAlerts, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: 52,
        right: 12,
        width: 340,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 50,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Alerts</strong>
        <Link
          to="/alerts"
          onClick={onClose}
          style={{ fontSize: 12, color: 'var(--text-muted)' }}
        >
          manage rules →
        </Link>
      </div>
      {activeAlerts.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '14px 4px' }}>
          No active alerts. All monitored metrics are within configured thresholds.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activeAlerts.map(({ rule, value, sustainedFor }) => {
            const meta = METRICS[rule.metric];
            const sevColor = rule.severity === 'crit' ? 'var(--crit)' : 'var(--warn)';
            const since = sinceForDuration(sustainedFor);
            const priority = rule.severity === 'crit' ? 3 : 4;
            return (
              <li
                key={rule.id}
                style={{
                  borderLeft: `3px solid ${sevColor}`,
                  background: 'var(--bg-card)',
                  padding: '8px 10px',
                  borderRadius: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{rule.label || meta.label}</strong>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {rule.severity}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {meta.label}: <strong style={{ color: 'var(--text)' }}>{meta.format(value)}</strong>{' '}
                  <span>{rule.comparator === 'gt' ? '>' : '<'} {meta.format(rule.threshold)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                    sustained for {formatDuration(sustainedFor)}
                  </span>
                  <Link
                    to={`/logs?since=${since}&priority=${priority}`}
                    onClick={onClose}
                    style={{ fontSize: 11, color: 'var(--text-muted)' }}
                  >
                    show logs →
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
