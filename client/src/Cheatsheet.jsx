import React, { useEffect } from 'react';

// Keyboard cheatsheet overlay. Triggered by `?`, dismissed by Esc / outside
// click. Stays compact — the goal is to be a memory aid for the chords, not
// a discoverability surface.

const SECTIONS = [
  {
    title: 'Navigate',
    rows: [
      { keys: ['g', 'd'], label: 'Dashboard' },
      { keys: ['g', 'h'], label: 'History' },
      { keys: ['g', 'o'], label: 'Hosts' },
      { keys: ['g', 's'], label: 'Storage' },
      { keys: ['g', 'p'], label: 'Processes' },
      { keys: ['g', 'k'], label: 'Docker' },
      { keys: ['g', 'v'], label: 'Services' },
      { keys: ['g', 'n'], label: 'Network' },
      { keys: ['g', 'c'], label: 'Connections' },
      { keys: ['g', 'a'], label: 'Alerts' },
      { keys: ['g', 'e'], label: 'Checks' },
      { keys: ['g', 'r'], label: 'Actions (runs)' },
      { keys: ['g', 'l'], label: 'Logs' },
      { keys: ['g', ','], label: 'Settings' },
    ],
  },
  {
    title: 'Help',
    rows: [
      { keys: ['?'], label: 'Toggle this cheatsheet' },
      { keys: ['Esc'], label: 'Close popovers / cheatsheet' },
    ],
  },
];

function Kbd({ children }) {
  return (
    <kbd
      style={{
        display: 'inline-block',
        minWidth: 22,
        padding: '2px 6px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        textAlign: 'center',
        boxShadow: '0 1px 0 var(--border-strong)',
      }}
    >
      {children}
    </kbd>
  );
}

export function Cheatsheet({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8, 12, 20, 0.55)',
        backdropFilter: 'blur(2px)',
        zIndex: 60,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 'min(640px, 100%)',
          maxHeight: '80vh',
          overflow: 'auto',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Keyboard shortcuts</h3>
          <button
            type="button"
            className="btn tiny ghost"
            onClick={onClose}
            aria-label="Close cheatsheet"
          >
            close
          </button>
        </div>
        <p className="dim" style={{ fontSize: 12, marginTop: 0, marginBottom: 18 }}>
          Two-key chords are typed in sequence (e.g. press <Kbd>g</Kbd> then <Kbd>d</Kbd>),
          not held together. Disabled while typing in an input.
        </p>
        <div style={{ display: 'grid', gap: 18 }}>
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <div className="section-title" style={{ margin: '0 0 8px' }}>{s.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 8, columnGap: 16 }}>
                {s.rows.map((r, i) => (
                  <React.Fragment key={i}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {r.keys.map((k, j) => (
                        <React.Fragment key={j}>
                          {j > 0 && <span className="dim" style={{ fontSize: 11 }}>then</span>}
                          <Kbd>{k}</Kbd>
                        </React.Fragment>
                      ))}
                    </div>
                    <div style={{ fontSize: 13, alignSelf: 'center' }}>{r.label}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
