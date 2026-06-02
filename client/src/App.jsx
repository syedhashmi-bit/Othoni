import React, { useEffect, useState, useRef, createContext, useContext } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api, setActiveHost } from './api';
import { useLocalSetting, useInFlightCount } from './hooks';
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
import Hosts from './pages/Hosts.jsx';
import HostDetail from './pages/HostDetail.jsx';
import Actions from './pages/Actions.jsx';
import Projects from './pages/Projects.jsx';
import Security from './pages/Security.jsx';
import { Logo } from './Logo.jsx';
import { Cheatsheet } from './Cheatsheet.jsx';
import {
  IconDashboard, IconHistory, IconStorage, IconProcesses,
  IconDocker, IconServices, IconNetwork, IconConnections, IconAlerts,
  IconChecks, IconLogs, IconSettings, IconHosts, IconActions,
  IconClock, IconSignOut, IconProjects, IconShield,
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
  o: '/hosts',
  r: '/actions',
  j: '/projects',
  u: '/security',
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

// Wrap any UI that would call a state-changing endpoint. Viewer sessions
// don't render it. The server's `requireAdmin` middleware is the real
// security boundary — this just keeps the UI honest.
export function AdminOnly({ children, fallback = null }) {
  const ctx = useApp();
  if (ctx?.user?.role !== 'admin') return fallback;
  return children;
}

const NAV = [
  { to: '/', label: 'Dashboard', end: true, Icon: IconDashboard },
  { to: '/history', label: 'History', Icon: IconHistory },
  { to: '/hosts', label: 'Hosts', Icon: IconHosts },
  { to: '/storage', label: 'Storage', Icon: IconStorage },
  { to: '/processes', label: 'Processes', Icon: IconProcesses },
  { to: '/docker', label: 'Docker', Icon: IconDocker },
  { to: '/services', label: 'Services', Icon: IconServices },
  { to: '/projects', label: 'Projects', Icon: IconProjects },
  { to: '/network', label: 'Network', Icon: IconNetwork },
  { to: '/connections', label: 'Connections', Icon: IconConnections },
  { to: '/alerts', label: 'Alerts', Icon: IconAlerts },
  { to: '/checks', label: 'Checks', Icon: IconChecks },
  { to: '/security', label: 'Security', Icon: IconShield },
  { to: '/actions', label: 'Actions', Icon: IconActions },
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

// 2px sweep bar pinned to the top of the viewport. Visible whenever any
// usePoller fetch is in flight. The CSS sweep animation runs constantly;
// the active/idle class just toggles opacity for a clean fade in/out.
function TopProgressBar() {
  const n = useInFlightCount();
  return <div className={`poll-progress ${n > 0 ? 'active' : 'idle'}`} aria-hidden="true" />;
}

function LiveIndicator({ refreshMs }) {
  return (
    <span className="live-indicator" title={`refreshing every ${refreshMs / 1000}s`}>
      <span className="live-dot" />
      <span>live · {refreshMs / 1000}s</span>
    </span>
  );
}

// Topbar quick-toggle for density. Same backing key as the Settings card
// (`othoni.density` via useApp()), so the two stay in sync. Lets users
// flip layout mid-page without going to /settings first.
function DensityToggle({ density, setDensity }) {
  const isCompact = density === 'compact';
  return (
    <span
      className="density-toggle"
      role="group"
      aria-label="Layout density"
      title="Layout density"
    >
      <button
        type="button"
        className={isCompact ? '' : 'active'}
        onClick={() => setDensity('comfortable')}
        aria-pressed={!isCompact}
      >
        cozy
      </button>
      <button
        type="button"
        className={isCompact ? 'active' : ''}
        onClick={() => setDensity('compact')}
        aria-pressed={isCompact}
      >
        dense
      </button>
    </span>
  );
}

// Topbar dropdown to switch which host's dashboard is in view.
//
// - "This server (live)" → the local box othoni runs on (every page reads
//   /proc directly).
// - "All hosts grid" → the /hosts overview of agent-pushed metrics.
// - "Federated hosts" → registered peers (full othoni instances on other
//   VPS). Selecting one sets the *view host*: every data page transparently
//   re-fetches that peer's stats through the read-only /api/fleet proxy, so
//   the complete dashboard reflects the remote box.
//
// The peer list refreshes every 30s so a freshly-registered peer appears
// shortly after it's added on Settings.
function HostSwitcher() {
  const navigate = useNavigate();
  const { viewHost, setViewHost } = useApp();
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.peers.list()
        .then((r) => { if (alive) setPeers(r.peers || []); })
        .catch(() => { /* transient — next tick retries */ });
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Keep the active view host selectable even before the list resolves (or
  // if it dropped out), so the control never shows blank.
  const names = peers.map((p) => p.host);
  if (viewHost && !names.includes(viewHost)) names.unshift(viewHost);

  const value = viewHost || '__local';

  function onChange(e) {
    const v = e.target.value;
    if (v === '__local') { setViewHost(null); navigate('/'); }
    else if (v === '__all') { setViewHost(null); navigate('/hosts'); }
    else { setViewHost(v); navigate('/'); }
  }

  return (
    <select
      className="select"
      value={value}
      onChange={onChange}
      title="Switch dashboard host"
      style={{ fontSize: 12, padding: '4px 26px 4px 10px', fontWeight: 500 }}
    >
      <option value="__local">This server (live)</option>
      <option value="__all">All hosts grid</option>
      {names.length > 0 && (
        <optgroup label="Federated hosts">
          {names.map((n) => (
            <option key={n} value={n}>{n} (full dashboard)</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function Shell({ user, onLogout, children, refreshMs, density, setDensity, activeAlerts, viewHost, onShortcutsClick }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  return (
    <>
    <TopProgressBar />
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={22} />
          Othoni
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
            {user?.role === 'viewer' && (
              <span className="chip dim" style={{ fontSize: 10, marginLeft: 4 }}>read-only</span>
            )}
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
          <HostSwitcher />
          {viewHost && (
            <span
              className="chip"
              title={`Dashboard pages are showing data from the federated peer "${viewHost}" (read-only, proxied).`}
              style={{ fontSize: 11, background: '#7c3aed', color: '#fff', fontWeight: 600 }}
            >
              remote · {viewHost}
            </span>
          )}
        </div>
        <div className="topbar-meta">
          {user?.role === 'viewer' && (
            <span
              className="chip dim"
              title="This account is read-only. State-changing controls are hidden."
              style={{ fontSize: 11 }}
            >
              read-only mode
            </span>
          )}
          <AlertBadge activeAlerts={activeAlerts} onClick={() => setPopoverOpen((v) => !v)} />
          <DensityToggle density={density} setDensity={setDensity} />
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
    </>
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
  const [density, setDensity] = useLocalSetting('othoni.density', 'comfortable');
  // Which host's dashboard is in view. null = the local box; otherwise the
  // `host` of a registered federation peer. Persisted so a refresh keeps the
  // remote view. Set synchronously below (not in an effect) so the module-
  // level API base is correct *before* any page's mount fetch fires.
  const [viewHost, setViewHost] = useLocalSetting('othoni.viewHost', null);
  setActiveHost(viewHost);
  const navigate = useNavigate();
  const alerts = useServerAlerts(!!user);

  // Push the density preference onto <body> as a data attribute so CSS
  // selectors can scope compact-mode rules — pure CSS, no per-component changes.
  useEffect(() => {
    if (density === 'compact') {
      document.body.dataset.density = 'compact';
    } else {
      delete document.body.dataset.density;
    }
  }, [density]);

  // Same trick for read-only viewer sessions — gives CSS a hook to hide
  // edit affordances (the form-disabled mixin in styles.css) without
  // every component reading context.
  useEffect(() => {
    if (user && user.role === 'viewer') {
      document.body.dataset.role = 'viewer';
    } else {
      delete document.body.dataset.role;
    }
  }, [user]);

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
    <AppCtx.Provider
      value={{ user, refreshMs, setRefreshMs, density, setDensity, viewHost, setViewHost, onLogout: handleLogout, ...alerts }}
    >
      <AuthedAppBody refreshMs={refreshMs} alerts={alerts} user={user} handleLogout={handleLogout} viewHost={viewHost} />
    </AppCtx.Provider>
  );
}

// Split out so `useKeyboardShortcuts` (which calls `useNavigate`) only runs
// inside the Shell — the unauthenticated branch never mounts the router
// content and shouldn't install global key listeners.
function AuthedAppBody({ refreshMs, alerts, user, handleLogout, viewHost }) {
  const { cheatsheetOpen, setCheatsheetOpen } = useKeyboardShortcuts();
  const { density, setDensity } = useApp();
  return (
    <Shell
      user={user}
      onLogout={handleLogout}
      refreshMs={refreshMs}
      density={density}
      setDensity={setDensity}
      activeAlerts={alerts.activeAlerts}
      viewHost={viewHost}
      onShortcutsClick={() => setCheatsheetOpen((v) => !v)}
    >
      {/* Remount the whole page subtree when the view host changes so every
          page re-fetches against the new source instead of waiting a poll
          tick with stale data. */}
      <Routes key={viewHost || '__local'}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/history" element={<History />} />
        <Route path="/hosts" element={<Hosts />} />
        <Route path="/hosts/:host" element={<HostDetail />} />
        <Route path="/actions" element={<Actions />} />
        <Route path="/security" element={<Security />} />
        <Route path="/storage" element={<Storage />} />
        <Route path="/processes" element={<Processes />} />
        <Route path="/docker" element={<Docker />} />
        <Route path="/services" element={<Services />} />
        <Route path="/projects" element={<Projects />} />
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
