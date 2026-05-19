import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useLocalSetting } from '../hooks';
import { IconPlus, IconTrash } from '../Icons.jsx';

// Dropdown options. Priorities are journalctl-style — pass a number 0-7,
// "show this level and more severe". `null` here = no priority filter,
// i.e. show everything.
const PRIORITIES = [
  { value: 3, label: 'err and above (0–3)' },
  { value: 4, label: 'warning and above (0–4)' },
  { value: 5, label: 'notice and above (0–5)' },
  { value: 6, label: 'info and above (0–6)' },
  { value: 7, label: 'all (0–7)' },
];

const SINCE = [
  { value: '', label: 'no time bound' },
  { value: '5m', label: 'last 5 minutes' },
  { value: '15m', label: 'last 15 minutes' },
  { value: '1h', label: 'last hour' },
  { value: '6h', label: 'last 6 hours' },
  { value: '24h', label: 'last 24 hours' },
  { value: 'today', label: 'since midnight' },
];

const LIMITS = [50, 100, 200, 500, 1000];

const LEVEL_ORDER = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

function chipVariantForLevel(level) {
  if (['emerg', 'alert', 'crit', 'err'].includes(level)) return 'crit';
  if (level === 'warning') return 'warn';
  if (level === 'notice') return 'accent';
  return '';
}

function LevelChip({ level }) {
  return (
    <span className={`chip ${chipVariantForLevel(level)}`} style={{ minWidth: 64, justifyContent: 'center', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10.5, fontWeight: 600 }}>
      {level}
    </span>
  );
}

function DisabledHint() {
  return (
    <div className="card" style={{ maxWidth: 720, marginTop: 16, padding: 24 }}>
      <div className="card-title" style={{ marginBottom: 10 }}>Logs collector disabled</div>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        The system logs feed is opt-in because journal entries can leak sensitive
        content (passwords / tokens / IPs in error messages, full command lines,
        kernel iptables logs with public IPs, etc.). Enable it explicitly:
      </p>
      <ol style={{ color: 'var(--text-muted)', paddingLeft: 20, lineHeight: 1.9 }}>
        <li>Add <code>OTHONI_LOGS_ENABLED=true</code> to <code>.env</code>.</li>
        <li>Restart: <code>sudo systemctl restart othoni</code>.</li>
        <li>Reload this page.</li>
      </ol>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 0 }}>
        The collector reads via <code>journalctl --output=json</code> (no shell).
        The Othoni process must have permission to read the journal — that's
        automatic when running as <code>root</code>; otherwise add the service
        user to the <code>systemd-journal</code> group.
      </p>
    </div>
  );
}

const VALID_SINCE = new Set(SINCE.map((s) => s.value));

// Convert a datetime-local input value (YYYY-MM-DDTHH:mm) → ms-since-epoch in
// the user's local timezone. Empty/invalid input returns null.
function localInputToMs(s) {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
// And the inverse — for prefilling the field from a numeric ms value.
function msToLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Split a message around case-insensitive matches of `q`, returning an array of
// alternating { text, hit } parts. Used by <Highlight> below. Cheap escape so
// users can paste paths/regex-like strings without crashing the regex engine.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function splitMatches(text, q) {
  if (!q || !text) return [{ text: String(text || ''), hit: false }];
  const re = new RegExp(escapeRe(q), 'gi');
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // safety: zero-width never happens with our escaped input but kept for sanity
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
function Highlight({ text, q }) {
  const parts = splitMatches(text || '', q);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            style={{
              background: 'rgba(245, 158, 11, 0.28)',
              color: 'inherit',
              padding: '0 1px',
              borderRadius: 2,
            }}
          >
            {p.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        )
      )}
    </>
  );
}

// ---------- Saved filter presets ----------

const PRESETS_KEY = 'othoni.logs.presets';
const MAX_PRESETS = 8;

function PresetsBar({ filters, onApply }) {
  const [presets, setPresets] = useLocalSetting(PRESETS_KEY, []);
  const [savingName, setSavingName] = useState('');
  const [adding, setAdding] = useState(false);

  function save() {
    const name = savingName.trim();
    if (!name) return;
    const next = presets.filter((p) => p.name !== name);
    next.unshift({ name, filters });
    setPresets(next.slice(0, MAX_PRESETS));
    setSavingName('');
    setAdding(false);
  }
  function remove(name) {
    setPresets(presets.filter((p) => p.name !== name));
  }

  return (
    <div className="toolbar" style={{ marginTop: 8 }}>
      <span className="dim" style={{ fontSize: 12 }}>Presets:</span>
      {presets.length === 0 && !adding && (
        <span className="dim" style={{ fontSize: 12 }}>none yet</span>
      )}
      {presets.map((p) => (
        <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
          <button
            type="button"
            className="btn tiny"
            onClick={() => onApply(p.filters)}
            title={`Apply: ${JSON.stringify(p.filters)}`}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            {p.name}
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={() => remove(p.name)}
            aria-label={`Delete preset ${p.name}`}
            title="Delete preset"
            style={{
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderLeft: 'none',
              padding: '4px 6px',
              color: 'var(--text-dim)',
            }}
          >
            <IconTrash />
          </button>
        </span>
      ))}
      {adding ? (
        <form
          onSubmit={(e) => { e.preventDefault(); save(); }}
          style={{ display: 'inline-flex', gap: 6 }}
        >
          <input
            type="text"
            value={savingName}
            placeholder="preset name"
            autoFocus
            maxLength={32}
            onChange={(e) => setSavingName(e.target.value)}
            className="input"
            style={{ width: 140 }}
          />
          <button type="submit" className="btn tiny">save</button>
          <button
            type="button"
            className="btn tiny ghost"
            onClick={() => { setAdding(false); setSavingName(''); }}
          >
            cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn tiny pushright"
          onClick={() => setAdding(true)}
          title="Save current filter set as a preset"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <IconPlus /> save current
        </button>
      )}
    </div>
  );
}

// ---------- Main page ----------

export default function Logs() {
  // Seed initial state from URL query params so deep links work
  // (e.g. from the alerts popover: /logs?since=15m&priority=4&unit=...).
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPriority = (() => {
    const v = parseInt(searchParams.get('priority') || '', 10);
    return Number.isFinite(v) && v >= 0 && v <= 7 ? v : 4;
  })();
  const initialSince = (() => {
    const v = searchParams.get('since') || '1h';
    return VALID_SINCE.has(v) ? v : '1h';
  })();
  const initialLimit = (() => {
    const v = parseInt(searchParams.get('limit') || '', 10);
    return LIMITS.includes(v) ? v : 200;
  })();
  const initialUnit = searchParams.get('unit') || '';
  const initialSearch = searchParams.get('q') || '';

  const [priority, setPriority] = useState(initialPriority);
  const [since, setSince] = useState(initialSince);
  const [limit, setLimit] = useState(initialLimit);
  const [unit, setUnit] = useState(initialUnit);
  const [search, setSearch] = useState(initialSearch);
  const [autoTail, setAutoTail] = useState(false);
  // Jump-to-time. When set, the first fetch uses this as `until` so the page
  // shows entries up to and including that moment. Pagination keeps walking
  // backward from there. Clear to return to the live tail.
  const [jumpAt, setJumpAt] = useState('');

  // Accumulated entries across pages (newest first). Reset on filter change.
  const [entries, setEntries] = useState([]);
  const [loadingFirst, setLoadingFirst] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const seqRef = useRef(0); // bump on filter change so stale fetches are dropped

  // Keep URL in sync with current filters (excluding pagination + jump-to-time
  // so deep-link semantics stay simple).
  useEffect(() => {
    const params = {};
    if (priority !== 4) params.priority = String(priority);
    if (since && since !== '1h') params.since = since;
    if (limit !== 200) params.limit = String(limit);
    if (unit) params.unit = unit;
    if (search) params.q = search;
    setSearchParams(params, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority, since, limit, unit, search]);

  // Fetch the first page whenever filters / jump-to-time change.
  const fetchFirst = useCallback(async () => {
    const my = ++seqRef.current;
    setLoadingFirst(true);
    setError(null);
    setExhausted(false);
    try {
      const jumpMs = localInputToMs(jumpAt);
      const r = await api.logs({
        limit,
        priority,
        unit: unit.trim() || null,
        since: jumpMs ? null : (since || null), // when jumping, ignore relative `since`
        until: jumpMs != null ? jumpMs + 1 : null, // +1 so the matched moment itself is included
      });
      if (my !== seqRef.current) return; // a newer fetch superseded this one
      if (!r.enabled) {
        setEnabled(false);
        return;
      }
      setEnabled(true);
      setEntries(r.entries || []);
      if (!r.entries?.length) setExhausted(true);
    } catch (e) {
      if (my === seqRef.current) setError(e);
    } finally {
      if (my === seqRef.current) setLoadingFirst(false);
    }
  }, [limit, priority, unit, since, jumpAt]);

  useEffect(() => { fetchFirst(); }, [fetchFirst]);

  // Auto-tail: every 5s, append any newer entries to the top. Pauses while
  // jump-to-time is set or while paginated past the first page. Pauses when
  // tab is hidden.
  useEffect(() => {
    if (!autoTail) return;
    if (jumpAt) return;
    const id = setInterval(async () => {
      if (document.hidden) return;
      const my = seqRef.current;
      try {
        const r = await api.logs({
          limit,
          priority,
          unit: unit.trim() || null,
          since: since || null,
        });
        if (my !== seqRef.current) return;
        if (!r.enabled) { setEnabled(false); return; }
        setEntries((prev) => {
          if (!prev.length) return r.entries || [];
          const newestT = prev[0]?.t || 0;
          const fresh = (r.entries || []).filter((e) => (e.t || 0) > newestT);
          return fresh.length ? [...fresh, ...prev] : prev;
        });
      } catch { /* swallow tail errors — UI shows last good state */ }
    }, 5000);
    return () => clearInterval(id);
  }, [autoTail, jumpAt, limit, priority, unit, since]);

  async function loadMore() {
    if (!entries.length || exhausted || loadingMore) return;
    const oldestT = entries[entries.length - 1]?.t;
    if (!oldestT) return;
    setLoadingMore(true);
    setError(null);
    const my = seqRef.current;
    try {
      const r = await api.logs({
        limit,
        priority,
        unit: unit.trim() || null,
        // When walking backward we ignore `since` after the first page —
        // otherwise journalctl would re-window from "1h ago", not "1h before
        // the oldest entry on screen", and we'd get the same rows again.
        since: null,
        until: oldestT,
      });
      if (my !== seqRef.current) return;
      if (!r.enabled) { setEnabled(false); return; }
      const fresh = r.entries || [];
      setEntries((prev) => [...prev, ...fresh]);
      if (fresh.length === 0) setExhausted(true);
    } catch (e) {
      if (my === seqRef.current) setError(e);
    } finally {
      if (my === seqRef.current) setLoadingMore(false);
    }
  }

  // Search filter (client-side). Pre-filtered list drives both the table and
  // the per-level counts so the toolbar reflects what's actually visible.
  const visible = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter((e) =>
      (e.message || '').toLowerCase().includes(q)
      || (e.unit || '').toLowerCase().includes(q)
      || (e.identifier || '').toLowerCase().includes(q)
    );
  }, [entries, search]);

  // Per-priority counts over the *visible* set.
  const counts = useMemo(() => {
    const c = {};
    for (const e of visible) c[e.level] = (c[e.level] || 0) + 1;
    return c;
  }, [visible]);

  function applyPreset(p) {
    if (p.priority != null) setPriority(p.priority);
    if (p.since != null) setSince(p.since);
    if (p.limit != null) setLimit(p.limit);
    if (p.unit != null) setUnit(p.unit);
    if (p.search != null) setSearch(p.search);
    setJumpAt(''); // presets always start at the live tail
  }

  if (!enabled) {
    return (
      <div className="page-fade-in">
        <h1 className="page-title">Logs</h1>
        <p className="subtitle">System log feed via journalctl.</p>
        <DisabledHint />
      </div>
    );
  }

  const currentFilters = { priority, since, limit, unit, search };
  const totalShown = visible.length;
  const totalLoaded = entries.length;

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Logs</h1>
      <p className="subtitle">
        System log feed via <code>journalctl --output=json</code>.
        {jumpAt && (
          <span style={{ color: 'var(--accent)', marginLeft: 8 }}>
            anchored at {new Date(localInputToMs(jumpAt)).toLocaleString([], { hour12: false })}
          </span>
        )}
      </p>

      <div className="toolbar sticky">
        <select value={priority} onChange={(e) => setPriority(parseInt(e.target.value, 10))} className="select">
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select value={since} onChange={(e) => setSince(e.target.value)} className="select">
          {SINCE.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          className="select"
        >
          {LIMITS.map((n) => <option key={n} value={n}>last {n}</option>)}
        </select>
        <input
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="filter by unit (e.g. nginx.service)"
          className="input mono grow"
        />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
            opacity: jumpAt ? 0.5 : 1,
          }}
          title={jumpAt ? 'auto-tail is paused while a jump time is set' : ''}
        >
          <input
            type="checkbox"
            checked={autoTail}
            onChange={(e) => setAutoTail(e.target.checked)}
            disabled={!!jumpAt}
          />
          auto-tail (5s)
        </label>
        <button type="button" className="btn ghost" onClick={fetchFirst}>Refresh</button>
      </div>

      <div className="toolbar" style={{ marginTop: 8 }}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search loaded entries (message, unit, identifier)…"
          className="input mono grow"
        />
        <label
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 13 }}
          title="Show entries up to and including this time, then walk backward via Load more"
        >
          jump to
          <input
            type="datetime-local"
            value={jumpAt}
            onChange={(e) => setJumpAt(e.target.value)}
            className="input mono"
            style={{ width: 200 }}
          />
          {jumpAt && (
            <button
              type="button"
              className="btn tiny ghost"
              onClick={() => setJumpAt('')}
              title="Clear jump time and return to live tail"
            >
              clear
            </button>
          )}
        </label>
      </div>

      <PresetsBar filters={currentFilters} onApply={applyPreset} />

      {/* Per-priority counts */}
      <div className="toolbar" style={{ marginTop: 12, gap: 6, flexWrap: 'wrap' }}>
        <span className="dim" style={{ fontSize: 12 }}>
          {totalShown}{search.trim() && totalShown !== totalLoaded ? ` of ${totalLoaded}` : ''} shown
        </span>
        {LEVEL_ORDER.map((lvl) => {
          const n = counts[lvl] || 0;
          if (!n) return null;
          return (
            <span key={lvl} className={`chip ${chipVariantForLevel(lvl)}`} style={{ fontSize: 11, padding: '2px 7px' }}>
              <span style={{ textTransform: 'lowercase' }}>{lvl}</span>
              <strong>{n}</strong>
            </span>
          );
        })}
      </div>

      {loadingFirst && entries.length === 0 && <div className="loading">Loading logs…</div>}
      {error && <div className="error">Could not read logs: {error.message}</div>}

      {!loadingFirst && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 170 }}>Time</th>
                  <th style={{ width: 88 }}>Level</th>
                  <th style={{ width: 220 }}>Unit / Identifier</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e, i) => (
                  <tr key={e.cursor || `${e.t}-${i}`}>
                    <td className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {e.t ? new Date(e.t).toLocaleString([], { hour12: false }) : '—'}
                    </td>
                    <td><LevelChip level={e.level} /></td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {e.unit ? (
                        <span style={{ color: 'var(--accent)' }}>
                          <Highlight text={e.unit} q={search} />
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>
                          <Highlight text={e.identifier || '—'} q={search} />
                        </span>
                      )}
                      {e.pid ? <span className="dim"> [{e.pid}]</span> : null}
                    </td>
                    <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      <Highlight text={e.message} q={search} />
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      {entries.length === 0
                        ? 'No log entries match the current filters.'
                        : 'No loaded entries match the search.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Load more older */}
      {!loadingFirst && entries.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
          {exhausted ? (
            <span className="dim" style={{ fontSize: 12 }}>
              no older entries match these filters
            </span>
          ) : (
            <button
              type="button"
              className="btn compact"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : `Load ${limit} older`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
