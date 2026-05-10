import React, { useEffect, useState, useRef, createContext, useContext } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useLocalSetting } from './hooks';
import { notifyFire } from './alerts';
import { AlertBadge, AlertsPopover } from './AlertsPopover.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Storage from './pages/Storage.jsx';
import Processes from './pages/Processes.jsx';
import Docker from './pages/Docker.jsx';
import Services from './pages/Services.jsx';
import Network from './pages/Network.jsx';
import Connections from './pages/Connections.jsx';
import Alerts from './pages/Alerts.jsx';
import Checks from './pages/Checks.jsx';
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import History from './pages/History.jsx';
import { Logo } from './Logo.jsx';
import { Cheatsheet } from './Cheatsheet.jsx';
import {
  IconDashboard, IconHistory, IconStorage, IconProcesses,
  IconDocker, IconServices, IconNetwork, IconConnections, IconAlerts,
  IconChecks, IconLogs, IconSettings,
  IconClock, IconSignOut,
} from './Icons.jsx';

// Two-key navigation chords: press `g` then one of these.
const G_CHORDS = {
  d: '/',
  h: '/history',
  s: '/storage',
  p: '/processes',
  k: '/docker',
  v: '/services',
  n: '/network',
  c: '/connections',
  a: '/alerts',
  e: '/checks',
  l: '/logs',
  ',': '/settings',
};
const CHORD_TIMEOUT_MS = 1500;

// Don't intercept keys while the user is typing in a form field. Also bail
// when any modifier is pressed so browser/OS shortcuts pass through cleanly.
function shouldIgnoreShortcut(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const el = e.target;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

// Owns the chord state machine + cheatsheet visibility. Mounted once at the
// app shell so listeners can be installed/torn down on login / logout.
function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const pending = useRef(null);    // 'g' when a chord prefix is active
  const timer = useRef(null);

  useEffect(() => {
    function clearPending() {
      pending.current = null;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    }
    function onKey(e) {
      if (shouldIgnoreShortcut(e)) {
        if (pending.current) clearPending();
        return;
      }
      // Esc closes the cheatsheet (handled in Cheatsheet too, but covering
      // here means it also dismisses any pending chord cleanly).
      if (e.key === 'Escape') {
        clearPending();
        if (cheatsheetOpen) setCheatsheetOpen(false);
        return;
      }
      // ? toggles the cheatsheet. On most layouts ? is shift+/, so check both.
      if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && !pending.current) {
        e.preventDefault();
        setCheatsheetOpen((v) => !v);
        return;
      }
      // Chord prefix.
      if (pending.current === null && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        pending.current = 'g';
        timer.current = setTimeout(clearPending, CHORD_TIMEOUT_MS);
        return;
      }
      // Chord completion.
      if (pending.current === 'g') {
        const k = e.key.toLowerCase();
        const dest = G_CHORDS[k];
        if (dest) {
          e.preventDefault();
          navigate(dest);
        }
        clearPending();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearPending();
    };
  }, [navigate, cheatsheetOpen]);

  return { cheatsheetOpen, setCheatsheetOpen };
}

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const NAV = [
  { to: '/', label: 'Dashboard', end: true, Icon: IconDashboard },
  { to: '/history', label: 'History', Icon: IconHistory },
  { to: '/storage', label: 'Storage', Icon: IconStorage },
  { to: '/processes', label: 'Processes', Icon: IconProcesses },
  { to: '/docker', label: 'Docker', Icon: IconDocker },
  { to: '/services', label: 'Services', Icon: IconServices },
  { to: '/network', label: 'Network', Icon: IconNetwork },
  { to: '/connections', label: 'Connections', Icon: IconConnections },
  { to: '/alerts', label: 'Alerts', Icon: IconAlerts },
  { to: '/checks', label: 'Checks', Icon: IconChecks },
  { to: '/logs', label: 'Logs', Icon: IconLogs },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
];

function ServerClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="topbar-clock" title={now.toString()}>
      <IconClock />
      <span className="mono">{now.toLocaleTimeString([], { hour12: false })}</span>
    </span>
  );
}

function LiveIndicator({ refreshMs }) {
  return (
    <span className="live-indicator" title={`refreshing every ${refreshMs / 1000}s`}>
      <span className="live-dot" />
      <span>live · {refreshMs / 1000}s</span>
    </span>
  );
}

function Shell({ user, onLogout, children, refreshMs, activeAlerts, onShortcutsClick }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={22} />
          othoni
        </div>
        <ul className="nav">
          {NAV.map(({ to, label, end, Icon }) => (
            <li className="nav-item" key={to}>
              <NavLink to={to} end={end}>
                <Icon className="nav-icon" />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <span className="user-chip">
            <span className="user-avatar">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{user?.username}</span>
          </span>
          <button className="icon-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
            <IconSignOut />
          </button>
        </div>
      </aside>
      <header className="topbar" style={{ position: 'relative' }}>
        <div className="topbar-title">
          <Logo size={16} />
          <span>VPS monitoring</span>
        </div>
        <div className="topbar-meta">
          <AlertBadge activeAlerts={activeAlerts} onClick={() => setPopoverOpen((v) => !v)} />
          <LiveIndicator refreshMs={refreshMs} />
          <ServerClock />
          <button
            type="button"
            className="topbar-bell"
            onClick={onShortcutsClick}
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            ?
          </button>
        </div>
        {popoverOpen && (
          <AlertsPopover
            activeAlerts={activeAlerts}
            onClose={() => setPopoverOpen(false)}
          />
        )}
      </header>
      <main className="main">{children}</main>
    </div>
  );
}

// Thin client poller — the alert engine itself moved to the server in
// v0.11.0. We just fetch /api/alerts/active every 10s, fire browser
// notifications on rules that newly transitioned to firing, and expose
// `activeAlerts` via context so the topbar bell + popover can render.
function useServerAlerts(active) {
  const [activeAlerts, setActiveAlerts] = useState([]);
  const knownIds = useRef(new Set());

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;

    const tick = async () => {
      try {
        const r = await api.alerts.active();
        if (stopped) return;
        const list = r.active || [];
        // Fire a browser notification for any alert id we haven't seen
        // before in this session.
        for (const a of list) {
          if (!knownIds.current.has(a.id)) {
            knownIds.current.add(a.id);
            notifyFire(a);
          }
        }
        // Forget ids that have resolved so a fresh fire later re-notifies.
        const stillActive = new Set(list.map((a) => a.id));
        for (const id of knownIds.current) {
          if (!stillActive.has(id)) knownIds.current.delete(id);
        }
        setActiveAlerts(list);
      } catch {
        /* one-off failure — next tick will retry */
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!document.hidden) await tick();
        if (!stopped) schedule();
      }, 10_000);
    };
    tick();
    schedule();
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active]);

  return { activeAlerts };
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = unknown, null = logged out
  const [refreshMs, setRefreshMs] = useLocalSetting('othoni.refreshMs', 5000);
  const navigate = useNavigate();
  const alerts = useServerAlerts(!!user);

  // Check session on mount
  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((r) => {
        if (alive) setUser(r.user);
      })
      .catch(() => {
        if (alive) setUser(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleLogin = (u) => {
    setUser(u);
    navigate('/', { replace: true });
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setUser(null);
    navigate('/login', { replace: true });
  };

  if (user === undefined) {
    return <div className="loading">Loading…</div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <AppCtx.Provider value={{ user, refreshMs, setRefreshMs, onLogout: handleLogout, ...alerts }}>
      <AuthedAppBody refreshMs={refreshMs} alerts={alerts} user={user} handleLogout={handleLogout} />
    </AppCtx.Provider>
  );
}

// Split out so `useKeyboardShortcuts` (which calls `useNavigate`) only runs
// inside the Shell — the unauthenticated branch never mounts the router
// content and shouldn't install global key listeners.
function AuthedAppBody({ refreshMs, alerts, user, handleLogout }) {
  const { cheatsheetOpen, setCheatsheetOpen } = useKeyboardShortcuts();
  return (
    <Shell
      user={user}
      onLogout={handleLogout}
      refreshMs={refreshMs}
      activeAlerts={alerts.activeAlerts}
      onShortcutsClick={() => setCheatsheetOpen((v) => !v)}
    >
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/history" element={<History />} />
        <Route path="/storage" element={<Storage />} />
        <Route path="/processes" element={<Processes />} />
        <Route path="/docker" element={<Docker />} />
        <Route path="/services" element={<Services />} />
        <Route path="/network" element={<Network />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/checks" element={<Checks />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Cheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </Shell>
  );
}
