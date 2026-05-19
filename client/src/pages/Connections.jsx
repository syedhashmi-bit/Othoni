import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { usePoller } from '../hooks';
import { useApp } from '../App.jsx';

// Heuristic: a "well-known" service binding shouldn't surprise anyone — show
// the service name in muted text alongside the port. Just a small set; the
// real point of the page is to expose what's bound, not to do nmap.
const PORT_NAMES = {
  22: 'ssh',
  25: 'smtp',
  53: 'dns',
  80: 'http',
  110: 'pop3',
  143: 'imap',
  443: 'https',
  465: 'smtps',
  587: 'submission',
  993: 'imaps',
  995: 'pop3s',
  3306: 'mysql',
  3389: 'rdp',
  5432: 'postgres',
  5672: 'amqp',
  6379: 'redis',
  8080: 'http-alt',
  8088: 'othoni',
  9090: 'prometheus',
  9100: 'node-exporter',
  9200: 'elasticsearch',
  11211: 'memcached',
  27017: 'mongodb',
};

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}
function isWildcard(ip) {
  return ip === '0.0.0.0' || ip === '::';
}

function chipVariantForState(state) {
  if (state === 'ESTABLISHED' || state === 'LISTEN') return state === 'LISTEN' ? 'accent' : 'ok';
  if (state === 'TIME_WAIT' || state === 'CLOSE') return '';
  if (state === 'CLOSE_WAIT' || state.startsWith('FIN_WAIT')) return 'warn';
  return '';
}

function StateChip({ state, count }) {
  return (
    <span className={`chip ${chipVariantForState(state)}`}>
      <span className="dot" />
      <span>{state.toLowerCase()}</span>
      {count != null && <strong>{count}</strong>}
    </span>
  );
}

// Tiny unstyled chip for state breakdowns inside top-talker rows. We render
// many of these per row, so they need to be more compact than the standard
// .chip with its dot + uppercase label.
function MiniStateChip({ state, count }) {
  const cls = chipVariantForState(state);
  return (
    <span
      className={`chip ${cls}`}
      style={{ padding: '2px 6px', fontSize: 11, gap: 4 }}
      title={`${state}: ${count}`}
    >
      <span style={{ color: 'var(--text-muted)', textTransform: 'lowercase' }}>{state.toLowerCase()}</span>
      <strong>{count}</strong>
    </span>
  );
}

function TopLocalPortsTable({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
        No active connections to group right now.
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="table-wrap" style={{ border: 'none' }}>
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Port</th>
              <th style={{ width: 110 }}>Service</th>
              <th style={{ width: 80 }}>Conns</th>
              <th>States</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.proto}-${r.port}`}>
                <td className="mono"><strong>{r.port}</strong></td>
                <td className="muted">{PORT_NAMES[r.port] || '—'}</td>
                <td className="mono">{r.total}</td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(r.states).map(([s, n]) => (
                      <MiniStateChip key={s} state={s.toUpperCase()} count={n} />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TopRemoteAddressesTable({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="empty" style={{ padding: '20px 0', fontSize: 13 }}>
        No remote addresses to group right now.
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="table-wrap" style={{ border: 'none' }}>
        <table className="t">
          <thead>
            <tr>
              <th>Remote IP</th>
              <th style={{ width: 80 }}>Conns</th>
              <th>To our ports</th>
              <th>States</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ip}>
                <td
                  className="mono"
                  style={{ color: isLoopback(r.ip) ? 'var(--text-dim)' : 'var(--text)' }}
                >
                  {r.ip}
                </td>
                <td className="mono">{r.total}</td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(r.ports || []).map((p) => (
                      <span key={p.port} className="mono" style={{ fontSize: 12 }}>
                        <strong>{p.port}</strong>
                        {PORT_NAMES[p.port] && (
                          <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>
                            {PORT_NAMES[p.port]}
                          </span>
                        )}
                        <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>×{p.n}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(r.states).map(([s, n]) => (
                      <MiniStateChip key={s} state={s.toUpperCase()} count={n} />
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatTile({ label, value, variant }) {
  return (
    <div className={`stat-tile ${variant || ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function AddrBindings({ addresses }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {addresses.map((a) => {
        const ip = a.replace(/\s+\(.*\)$/, '');
        const proto = a.match(/\(([^)]+)\)/)?.[1] || '';
        const color =
          isWildcard(ip) ? 'var(--accent)'
          : isLoopback(ip) ? 'var(--text-dim)'
          : 'var(--text)';
        return (
          <span key={a} className="mono" style={{ fontSize: 12, color }}>
            {ip}
            <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>{proto}</span>
          </span>
        );
      })}
    </div>
  );
}

export default function Connections() {
  const { refreshMs } = useApp();
  const { data, loading, error } = usePoller(api.connections, refreshMs);
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('all');

  const filteredActive = useMemo(() => {
    if (!data?.active) return [];
    let rows = data.active;
    if (stateFilter !== 'all') rows = rows.filter((r) => r.state === stateFilter);
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      rows = rows.filter((r) =>
        r.local.ip.includes(q)
        || r.remote.ip.includes(q)
        || String(r.local.port).includes(q)
        || String(r.remote.port).includes(q)
        || r.state.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, filter, stateFilter]);

  if (loading && !data) return <div className="loading">Loading connections…</div>;
  if (error && !data) return <div className="error">Could not read /proc/net/{`{tcp,tcp6,udp,udp6}`}.</div>;

  const summary = data?.summary || {};
  const states = summary.states || {};

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Connections</h1>
      <p className="subtitle">
        Listening ports + active TCP connections from <code>/proc/net/{`{tcp,tcp6,udp,udp6}`}</code>.
        {data?.truncated && (
          <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
            (showing first 1000 of {data.activeTotal} active)
          </span>
        )}
      </p>

      <div className="grid cols-4">
        <StatTile label="Established" value={summary.established || 0} variant="ok" />
        <StatTile label="Listening" value={summary.listening || 0} variant="accent" />
        <StatTile label="Time-wait" value={summary.timeWait || 0} variant="dim" />
        <StatTile
          label="Total sockets"
          value={(summary.tcp4 || 0) + (summary.tcp6 || 0) + (summary.udp4 || 0) + (summary.udp6 || 0)}
        />
      </div>

      {Object.keys(states).length > 0 && (
        <>
          <div className="section-title">TCP states</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(states)
              .sort((a, b) => b[1] - a[1])
              .map(([s, n]) => <StateChip key={s} state={s} count={n} />)}
          </div>
        </>
      )}

      <div className="section-title">Listening ports</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrap" style={{ border: 'none' }}>
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 80 }}>Proto</th>
                <th style={{ width: 100 }}>Port</th>
                <th>Service</th>
                <th>Bound on</th>
              </tr>
            </thead>
            <tbody>
              {(data?.listening || []).map((l) => (
                <tr key={`${l.protocol}-${l.port}`}>
                  <td className="mono">{l.protocol}</td>
                  <td className="mono"><strong>{l.port}</strong></td>
                  <td className="muted">{PORT_NAMES[l.port] || '—'}</td>
                  <td><AddrBindings addresses={l.addresses} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section-title">
        Top local ports
        <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          which of your services has the most concurrent connections — concentration on a single port (e.g. 22) is often the first sign of a brute-force / scrape attempt
        </span>
      </div>
      <TopLocalPortsTable rows={data?.topLocalPorts} />

      <div className="section-title">
        Top remote addresses
        <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          which remote IPs have the most connections to you — single-source concentration here is a different signal (a chatty client, scraper, or single attacker)
        </span>
      </div>
      <TopRemoteAddressesTable rows={data?.topRemoteAddresses} />

      <div className="section-title">
        Active TCP connections
        <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          {filteredActive.length}
          {filteredActive.length !== (data?.active?.length || 0) && ` of ${data?.active?.length || 0}`}
          {' '}shown
        </span>
      </div>

      <div className="toolbar sticky">
        <input
          type="text"
          placeholder="Filter by IP, port, or state…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input mono grow"
        />
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="select"
        >
          <option value="all">All states</option>
          {Object.keys(states).filter((s) => s !== 'LISTEN').map((s) => (
            <option key={s} value={s}>{s.toLowerCase()}</option>
          ))}
        </select>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrap" style={{ border: 'none' }}>
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 70 }}>Proto</th>
                <th>Local</th>
                <th>Remote</th>
                <th style={{ width: 130 }}>State</th>
              </tr>
            </thead>
            <tbody>
              {filteredActive.map((c, i) => (
                <tr key={i}>
                  <td className="mono">{c.protocol}</td>
                  <td className="mono" style={{ color: isLoopback(c.local.ip) ? 'var(--text-dim)' : 'var(--text)' }}>
                    {c.local.ip}<span style={{ color: 'var(--text-muted)' }}>:{c.local.port}</span>
                  </td>
                  <td className="mono" style={{ color: isLoopback(c.remote.ip) ? 'var(--text-dim)' : 'var(--text)' }}>
                    {c.remote.ip}<span style={{ color: 'var(--text-muted)' }}>:{c.remote.port}</span>
                  </td>
                  <td><StateChip state={c.state} /></td>
                </tr>
              ))}
              {filteredActive.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    {data?.active?.length ? 'No connections match the filter.' : 'No active connections.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
