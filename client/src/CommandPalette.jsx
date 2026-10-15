import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { SETTINGS_TABS } from './lib/settingsTabs';

// Ctrl/Cmd+K jump box: pages, Settings sections, hosts / peers, and a few
// commands. Items are plain { id, group, label, hint?, keywords?, run }.
// Matching is a cheap subsequence score — no fuzzy-search dependency.

function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;
  if (idx > 0) return 500 - idx;
  // Subsequence: every query char appears in order. Reward tight runs.
  let ti = 0;
  let run = 0;
  let total = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    total += 1 + run;
    ti = found + 1;
  }
  return total;
}

function usePaletteHosts(open) {
  const [peers, setPeers] = useState([]);
  const [agentHosts, setAgentHosts] = useState([]);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    api.peers.list()
      .then((r) => { if (alive) setPeers(r.peers || []); })
      .catch(() => {});
    api.hosts()
      .then((r) => { if (alive) setAgentHosts(r.hosts || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open]);
  return { peers, agentHosts };
}

export function CommandPalette({ open, onClose, pages, commands, navigate, setViewHost }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const { peers, agentHosts } = usePaletteHosts(open);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
      // Focus after the backdrop mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo(() => {
    const out = [];
    for (const p of pages) {
      out.push({ id: `page:${p.to}`, group: 'Pages', label: p.label, hint: p.chord, run: () => navigate(p.to) });
    }
    for (const t of SETTINGS_TABS) {
      for (const s of t.sections) {
        out.push({
          id: `settings:${s.id}`,
          group: 'Settings',
          label: `Settings › ${s.label}`,
          keywords: `${t.label} ${s.keywords || ''}`,
          run: () => navigate(`/settings#${s.id}`),
        });
      }
    }
    out.push({
      id: 'host:__local', group: 'Hosts', label: 'This server (live)',
      keywords: 'local self home',
      run: () => { setViewHost(null); navigate('/'); },
    });
    for (const p of peers) {
      out.push({
        id: `peer:${p.host}`, group: 'Hosts', label: `${p.host} — full dashboard`,
        hint: 'peer', keywords: `${p.label || ''} ${p.place || ''} peer federated remote`,
        run: () => { setViewHost(p.host); navigate('/'); },
      });
    }
    for (const h of agentHosts) {
      out.push({
        id: `agent:${h.host}`, group: 'Hosts', label: `${h.host} — agent metrics`,
        hint: 'agent', keywords: 'host detail',
        run: () => navigate(`/hosts/${encodeURIComponent(h.host)}`),
      });
    }
    for (const c of commands) out.push({ ...c, group: 'Commands' });
    return out;
  }, [pages, commands, peers, agentHosts, navigate, setViewHost]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    return items
      .map((it) => ({ it, s: Math.max(score(q, it.label), score(q, it.keywords || '') * 0.5) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.it);
  }, [items, query]);

  useEffect(() => { setSel(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  function choose(item) {
    if (!item) return;
    onClose();
    item.run();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  // Ranked results interleave groups, so headers only make sense unfiltered;
  // while searching the group is shown as the row hint instead.
  const showGroups = !query.trim();
  let lastGroup = null;
  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div
        className="popover palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a page, setting, or host…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((it, i) => {
            const header = showGroups && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const hint = it.hint || (showGroups ? null : it.group.toLowerCase());
            return (
              <React.Fragment key={it.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  data-idx={i}
                  role="option"
                  aria-selected={i === sel}
                  className={`palette-item${i === sel ? ' active' : ''}`}
                  onMouseMove={() => { if (i !== sel) setSel(i); }}
                  onClick={() => choose(it)}
                >
                  <span>{it.label}</span>
                  {hint && <span className="palette-hint">{hint}</span>}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>enter</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
