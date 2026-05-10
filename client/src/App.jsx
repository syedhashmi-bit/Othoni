import React, { useEffect, useState, useRef, useCallback, createContext, useContext } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useLocalSetting } from './hooks';
import {
  loadRules, saveRules, defaultRules, evaluate, activeAlerts as projectActive,
  notifyFire,
} from './alerts';
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
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import History from './pages/History.jsx';
import { Logo } from './Logo.jsx';
import {
  IconDashboard, IconHistory, IconStorage, IconProcesses,
  IconDocker, IconServices, IconNetwork, IconConnections, IconAlerts,
  IconLogs, IconSettings,
  IconClock, IconSignOut,
} from './Icons.jsx';

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

function Shell({ user, onLogout, children, refreshMs, activeAlerts }) {
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

// Polls /api/overview every 10s and runs the alerts engine. Owns rules
// (persisted to localStorage) + per-rule firing state (in-memory only).
// Exposes { rules, setRules, alertState, activeAlerts } via App context.
function useAlertsEngine(active) {
  const [rules, setRulesState] = useState(() => {
    const stored = loadRules();
    if (stored && stored.length) return stored;
    const seeded = defaultRules();
    saveRules(seeded);
    return seeded;
  });
  const [alertState, setAlertState] = useState({});
  const stateRef = useRef({});
  const rulesRef = useRef(rules);

  const setRules = useCallback((next) => {
    const arr = typeof next === 'function' ? next(rulesRef.current) : next;
    rulesRef.current = arr;
    setRulesState(arr);
    saveRules(arr);
  }, []);

  useEffect(() => { rulesRef.current = rules; }, [rules]);

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;

    const tick = async () => {
      try {
        const overview = await api.overview();
        if (stopped) return;
        const { state, fires } = evaluate(stateRef.current, rulesRef.current, overview);
        stateRef.current = state;
        setAlertState(state);
        for (const { rule, value } of fires) notifyFire(rule, value);
      } catch {
        /* ignore one-off failures — next tick will retry */
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

  const active_alerts = projectActive(rules, alertState);

  return { rules, setRules, alertState, activeAlerts: active_alerts };
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = unknown, null = logged out
  const [refreshMs, setRefreshMs] = useLocalSetting('othoni.refreshMs', 5000);
  const navigate = useNavigate();
  const alerts = useAlertsEngine(!!user);

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
      <Shell user={user} onLogout={handleLogout} refreshMs={refreshMs} activeAlerts={alerts.activeAlerts}>
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
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </AppCtx.Provider>
  );
}
