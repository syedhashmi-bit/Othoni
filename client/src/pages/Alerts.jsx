import React, { useEffect, useState } from 'react';
import { useApp } from '../App.jsx';
import {
  METRICS,
  newRuleId,
  defaultRules,
  notifyEnabled as readNotifyEnabled,
  setNotifyEnabled,
  formatDuration,
} from '../alerts';
import { IconPlus, IconTrash } from '../Icons.jsx';

const DURATIONS = [
  { ms: 0, label: 'immediate' },
  { ms: 60_000, label: '1 min' },
  { ms: 5 * 60_000, label: '5 min' },
  { ms: 15 * 60_000, label: '15 min' },
  { ms: 30 * 60_000, label: '30 min' },
];

function RuleRow({ rule, state, onChange, onDelete }) {
  const meta = METRICS[rule.metric];
  const live = state?.lastValue;
  const sevColor = rule.severity === 'crit' ? 'var(--crit)' : 'var(--warn)';
  return (
    <tr style={{ opacity: rule.enabled ? 1 : 0.55 }}>
      <td>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          aria-label="Enable rule"
        />
      </td>
      <td>
        <input
          type="text"
          value={rule.label}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
          placeholder="(unnamed)"
          className="input"
          style={{ width: 170 }}
        />
      </td>
      <td>
        <select
          value={rule.metric}
          onChange={(e) => onChange({ ...rule, metric: e.target.value })}
          className="select"
        >
          {Object.entries(METRICS).map(([k, m]) => (
            <option key={k} value={k}>{m.label}</option>
          ))}
        </select>
      </td>
      <td>
        <select
          value={rule.comparator}
          onChange={(e) => onChange({ ...rule, comparator: e.target.value })}
          className="select"
          style={{ width: 64 }}
        >
          <option value="gt">&gt;</option>
          <option value="lt">&lt;</option>
        </select>
      </td>
      <td>
        <input
          type="number"
          value={rule.threshold}
          step={meta?.unit === 'B/s' ? 100000 : meta?.unit === '%' ? 1 : 0.1}
          onChange={(e) => onChange({ ...rule, threshold: parseFloat(e.target.value) || 0 })}
          className="input mono"
          style={{ width: 110 }}
        />
        <span className="dim" style={{ marginLeft: 6, fontSize: 12 }}>{meta?.unit}</span>
      </td>
      <td>
        <select
          value={rule.durationMs}
          onChange={(e) => onChange({ ...rule, durationMs: parseInt(e.target.value, 10) })}
          className="select"
        >
          {DURATIONS.map((d) => (
            <option key={d.ms} value={d.ms}>{d.label}</option>
          ))}
        </select>
      </td>
      <td>
        <select
          value={rule.severity}
          onChange={(e) => onChange({ ...rule, severity: e.target.value })}
          className="select"
          style={{ color: sevColor, fontWeight: 600 }}
        >
          <option value="warn">warn</option>
          <option value="crit">crit</option>
        </select>
      </td>
      <td className="mono" style={{ minWidth: 110 }}>
        {live != null ? (
          <span style={{ color: state?.firing ? sevColor : 'var(--text-muted)' }}>
            {meta.format(live)}
          </span>
        ) : (
          <span className="dim">—</span>
        )}
        {state?.firing && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            firing · {formatDuration(Date.now() - state.firstBreachAt)}
          </div>
        )}
      </td>
      <td>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete rule"
          title="Delete rule"
          className="icon-btn"
        >
          <IconTrash />
        </button>
      </td>
    </tr>
  );
}

export default function Alerts() {
  const { rules, setRules, alertState } = useApp();
  const [notify, setNotify] = useState(readNotifyEnabled());

  useEffect(() => { setNotify(readNotifyEnabled()); }, []);

  function update(id, next) { setRules(rules.map((r) => (r.id === id ? next : r))); }
  function remove(id) { setRules(rules.filter((r) => r.id !== id)); }
  function add() {
    setRules([
      ...rules,
      {
        id: newRuleId(),
        enabled: true,
        metric: 'cpu',
        comparator: 'gt',
        threshold: 80,
        durationMs: 60_000,
        severity: 'warn',
        label: 'New rule',
      },
    ]);
  }
  function seedDefaults() {
    if (rules.length && !confirm('Replace existing rules with the defaults?')) return;
    setRules(defaultRules());
  }
  async function toggleNotify() {
    const ok = await setNotifyEnabled(!notify);
    setNotify(ok);
  }

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Alerts</h1>
      <p className="subtitle">
        Threshold rules evaluated against the live overview every 10s. Rules
        and firing state are stored in this browser only — they don't sync
        across devices.
      </p>

      <div className="toolbar">
        <button
          type="button"
          className="btn compact"
          onClick={add}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <IconPlus /> Add rule
        </button>
        <button type="button" className="btn ghost" onClick={seedDefaults}>
          Seed defaults
        </button>
        <label
          className="pushright"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-muted)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <input type="checkbox" checked={notify} onChange={toggleNotify} />
          Browser notifications when rules fire
        </label>
      </div>

      {rules.length === 0 ? (
        <div className="card empty" style={{ padding: 32 }}>
          No rules yet. Click <strong>Add rule</strong> to create one, or
          {' '}<strong>Seed defaults</strong> for a starter set
          (CPU / memory / disk all &gt; 90%).
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap" style={{ border: 'none' }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>On</th>
                  <th>Label</th>
                  <th>Metric</th>
                  <th>Op</th>
                  <th>Threshold</th>
                  <th>Sustained</th>
                  <th>Severity</th>
                  <th>Now</th>
                  <th style={{ width: 50 }}></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    state={alertState[r.id]}
                    onChange={(next) => update(r.id, next)}
                    onDelete={() => remove(r.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
