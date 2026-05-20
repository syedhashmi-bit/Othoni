import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App.jsx';
import { Sparkline } from '../Charts.jsx';

const SEV_LABEL = { crit: 'Critical', warn: 'Warning', info: 'Info', ok: 'OK' };
const SEV_ORDER = ['crit', 'warn', 'info', 'ok'];
const SEV_COLOR = {
  crit: 'var(--crit)',
  warn: 'var(--warn)',
  info: 'var(--text-dim)',
  ok:   'var(--ok)',
};

function relativeTime(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 1000) return 'just now';
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 24 * 3_600_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / (24 * 3_600_000))}d ago`;
}

function daysFromNow(ms) {
  if (!ms) return null;
  return Math.round((ms - Date.now()) / (24 * 3_600_000));
}

function SeverityChip({ severity, dim = false }) {
  const klass = severity === 'ok' ? 'ok'
    : severity === 'warn' ? 'warn'
    : severity === 'crit' ? 'crit'
    : 'dim';
  return (
    <span className={`pill ${klass}`} style={{ fontSize: 10, opacity: dim ? 0.55 : 1 }}>
      {SEV_LABEL[severity] || severity}
    </span>
  );
}

function AckDialog({ finding, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [ttlDays, setTtlDays] = useState(30);
  if (!finding) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div className="popover" style={{ minWidth: 360, maxWidth: 520, padding: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Acknowledge finding</div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
          Acked findings are hidden from severity counts and demoted in the list.
          They re-surface after the TTL expires.
        </div>
        <div style={{ fontSize: 13, padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', marginBottom: 12 }}>
          <SeverityChip severity={finding.severity} /> {finding.title}
        </div>
        <label className="form-row" style={{ display: 'block', marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Reason (optional)</div>
          <input
            type="text"
            className="input"
            placeholder="e.g. Port 22 is intentional"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={280}
            style={{ width: '100%' }}
          />
        </label>
        <label className="form-row" style={{ display: 'block', marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Expires after (days)</div>
          <input
            type="number"
            className="input"
            min={1}
            max={365}
            value={ttlDays}
            onChange={(e) => setTtlDays(Math.max(1, Math.min(365, parseInt(e.target.value || '30', 10) || 30)))}
            style={{ width: 100 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => onConfirm({ reason, ttlDays })}>
            Acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}

function RemediationButton({ finding, busy, onRemediate }) {
  const [confirming, setConfirming] = useState(false);
  if (!finding.remediation) return null;
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn compact"
        disabled={busy}
        onClick={() => setConfirming(true)}
        style={{ fontSize: 11 }}
      >
        Remediate
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="muted" style={{ fontSize: 11 }}>Apply fix?</span>
      <button
        type="button"
        className="btn compact"
        disabled={busy}
        onClick={() => { setConfirming(false); onRemediate(finding); }}
        style={{ fontSize: 11, background: 'var(--warn)', borderColor: 'var(--warn)' }}
      >
        {busy ? 'Working…' : 'Confirm'}
      </button>
      <button type="button" className="btn ghost compact" onClick={() => setConfirming(false)} style={{ fontSize: 11 }}>
        Cancel
      </button>
    </span>
  );
}

function SnoozeMenu({ onPick }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="btn ghost compact"
        onClick={() => setOpen(true)}
        style={{ fontSize: 11 }}
        title="Suppress this finding for a few hours"
      >
        Snooze ▾
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {[
        { h: 1,  label: '1h'  },
        { h: 4,  label: '4h'  },
        { h: 24, label: '24h' },
      ].map((o) => (
        <button
          key={o.h}
          type="button"
          className="btn ghost compact"
          onClick={() => { setOpen(false); onPick(o.h); }}
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          {o.label}
        </button>
      ))}
      <button type="button" className="btn ghost compact" onClick={() => setOpen(false)} style={{ fontSize: 11, padding: '2px 6px' }}>
        ×
      </button>
    </span>
  );
}

function Finding({ f, isAdmin, onAck, onUnack, onSnooze, onRemediate, remediateBusy }) {
  const accentBar = SEV_COLOR[f.severity] || 'var(--text-dim)';
  return (
    <div
      className="card"
      style={{
        padding: '14px 16px',
        borderLeft: `3px solid ${accentBar}`,
        marginBottom: 8,
        opacity: f.acked ? 0.65 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <SeverityChip severity={f.severity} dim={f.acked} />
            <div style={{ fontWeight: 600, fontSize: 14 }}>{f.title}</div>
            {f.acked && (
              <span className="pill" style={{ fontSize: 10, background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                {f.ackSnooze ? 'Snoozed' : 'Acked'}
                {f.ackExpiresAt && (
                  f.ackSnooze
                    ? ` · ${Math.max(1, Math.round((f.ackExpiresAt - Date.now()) / 3_600_000))}h left`
                    : ` · ${daysFromNow(f.ackExpiresAt)}d left`
                )}
              </span>
            )}
          </div>
          {f.detail && (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
              {f.detail}
            </div>
          )}
          {f.ackReason && f.acked && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, fontStyle: 'italic' }}>
              Reason: {f.ackReason}
            </div>
          )}
          {f.evidence && (
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                marginTop: 8,
                padding: '6px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-xs)',
                color: 'var(--text-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {f.evidence}
            </div>
          )}
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            {f.remediation && !f.acked && (
              <RemediationButton finding={f} busy={remediateBusy === f.id} onRemediate={onRemediate} />
            )}
            {f.severity !== 'ok' && (
              f.acked ? (
                <button type="button" className="btn ghost compact" onClick={() => onUnack(f)} style={{ fontSize: 11 }}>
                  {f.ackSnooze ? 'Unsnooze' : 'Unack'}
                </button>
              ) : (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  <SnoozeMenu onPick={(hours) => onSnooze(f, hours)} />
                  <button type="button" className="btn ghost compact" onClick={() => onAck(f)} style={{ fontSize: 11 }}>
                    Ack
                  </button>
                </span>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffStrip({ diff }) {
  if (!diff) return null;
  const { added = [], fixed = [], escalated = [] } = diff;
  if (added.length + fixed.length + escalated.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        No changes since the previous run.
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--crit)' }} />
        <strong style={{ fontSize: 13 }}>{added.length}</strong>
        <span className="muted" style={{ fontSize: 12 }}>new</span>
      </span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warn)' }} />
        <strong style={{ fontSize: 13 }}>{escalated.length}</strong>
        <span className="muted" style={{ fontSize: 12 }}>escalated</span>
      </span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ok)' }} />
        <strong style={{ fontSize: 13 }}>{fixed.length}</strong>
        <span className="muted" style={{ fontSize: 12 }}>fixed</span>
      </span>
      <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
        compared to previous audit run
      </span>
    </div>
  );
}

function HistoryCard({ history, range, onRangeChange }) {
  const runs = history?.runs || [];
  const critPoints = runs.map((r) => ({ t: r.t, v: r.crit }));
  const warnPoints = runs.map((r) => ({ t: r.t, v: r.warn }));

  const last = runs[runs.length - 1];
  const summary = last
    ? { crit: last.crit, warn: last.warn, info: last.info, total: last.total }
    : null;

  return (
    <div className="card" style={{ padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Audit history</strong>
        <span className="muted" style={{ fontSize: 11 }}>
          {runs.length} run{runs.length === 1 ? '' : 's'} — auto-runs every 10 min
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {['24h', '7d', '30d'].map((r) => (
            <button
              key={r}
              type="button"
              className={`btn ghost compact${range === r ? ' active' : ''}`}
              onClick={() => onRangeChange(r)}
              style={{ fontSize: 11, padding: '4px 10px' }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {runs.length < 2 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {runs.length === 0 ? 'No runs in this range yet.' : 'Need at least two runs to chart a trend. Check back in a few minutes.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Critical
            </div>
            <Sparkline points={critPoints} color="var(--crit)" showStats />
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Warning
            </div>
            <Sparkline points={warnPoints} color="var(--warn)" showStats />
          </div>
        </div>
      )}
      {summary && (
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
          Most recent run · {summary.crit} crit · {summary.warn} warn · {summary.info} info · {summary.total} total
        </div>
      )}
    </div>
  );
}

export default function Security() {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyRange, setHistoryRange] = useState('7d');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState(null);
  const [showAcked, setShowAcked] = useState(false);
  const [ackTarget, setAckTarget] = useState(null);
  const [remediateBusy, setRemediateBusy] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);

  function loadAudit({ force = false } = {}) {
    if (force) setRunning(true);
    api.securityAudit({ force })
      .then((r) => { setData(r); setErr(null); })
      .catch((e) => setErr(e.body?.message || e.message))
      .finally(() => { setLoading(false); setRunning(false); });
  }

  function loadHistory(range = historyRange) {
    api.securityHistory(range)
      .then((r) => setHistory(r))
      .catch(() => { /* non-fatal */ });
  }

  useEffect(() => {
    loadAudit();
    loadHistory(historyRange);
    const id = setInterval(() => { loadAudit(); loadHistory(historyRange); }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadHistory(historyRange); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [historyRange]);

  function ack(finding) { setAckTarget(finding); }
  function confirmAck({ reason, ttlDays }) {
    if (!ackTarget) return;
    api.securityAck({ id: ackTarget.id, reason, ttlDays })
      .then(() => { setAckTarget(null); loadAudit({ force: true }); })
      .catch((e) => { setErr(e.body?.message || e.message); setAckTarget(null); });
  }
  function unack(f) {
    api.securityUnack(f.id)
      .then(() => loadAudit({ force: true }))
      .catch((e) => setErr(e.body?.message || e.message));
  }
  function snooze(f, hours) {
    api.securityAck({ id: f.id, ttlHours: hours, snooze: true, reason: `Snoozed ${hours}h` })
      .then(() => loadAudit({ force: true }))
      .catch((e) => setErr(e.body?.message || e.message));
  }
  function remediate(f) {
    if (!f.remediation) return;
    setRemediateBusy(f.id);
    setActionMsg(null);
    api.actions.run({ kind: f.remediation.kind, target: f.remediation.target })
      .then((r) => {
        const ok = r.result?.ok;
        setActionMsg({
          ok,
          text: ok
            ? `Applied: ${f.remediation.target}. ${r.result?.stdout?.split('\n')[0] || ''}`
            : `Failed: ${f.remediation.target}. ${r.result?.stderr || ''}`,
        });
        loadAudit({ force: true });
      })
      .catch((e) => {
        setActionMsg({ ok: false, text: e.body?.message || e.message || 'unknown error' });
      })
      .finally(() => setRemediateBusy(null));
  }

  const findings = data?.findings || [];
  const filteredBySeverity = filter ? findings.filter((f) => f.severity === filter) : findings;
  const filtered = showAcked ? filteredBySeverity : filteredBySeverity.filter((f) => !f.acked);
  const summary = data?.summary || { crit: 0, warn: 0, info: 0, ok: 0, total: 0, acked: 0 };

  const byCategory = {};
  for (const f of filtered) {
    (byCategory[f.category] = byCategory[f.category] || []).push(f);
  }
  const categories = Object.keys(byCategory).sort((a, b) => {
    const worst = (list) => Math.min(...list.map((f) => SEV_ORDER.indexOf(f.severity)));
    return worst(byCategory[a]) - worst(byCategory[b]);
  });

  const score = summary.crit > 0 ? 'crit' : summary.warn > 0 ? 'warn' : 'ok';
  const scoreLabel = score === 'crit' ? 'Attention needed'
    : score === 'warn' ? 'Mostly clean'
    : 'No issues found';

  if (loading && !data) return <div className="loading">Running audit…</div>;

  return (
    <div className="page-fade-in">
      <h1 className="page-title">Security audit</h1>
      <p className="subtitle">
        Read-only checks across the VPS surface: open ports, SSH config, firewall,
        OS updates, filesystem permissions, SUID baseline, TLS expiry, sudoers,
        Docker socket, and unattended-upgrades. New crit findings dispatch to
        configured webhooks; safe one-click fixes are gated behind the actions
        framework.
      </p>

      {err && <div className="error">{err}</div>}
      {actionMsg && (
        <div className={`card`} style={{ padding: 10, marginBottom: 12, borderLeft: `3px solid ${actionMsg.ok ? 'var(--ok)' : 'var(--crit)'}`, fontSize: 12.5 }}>
          {actionMsg.text}
          <button type="button" className="btn ghost compact" onClick={() => setActionMsg(null)} style={{ float: 'right', fontSize: 11 }}>
            Dismiss
          </button>
        </div>
      )}

      <div
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 16,
          padding: 16,
          marginBottom: 16,
          borderColor: score === 'crit' ? 'var(--crit)' : score === 'warn' ? 'var(--warn)' : 'var(--ok)',
        }}
      >
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Overall
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              marginTop: 2,
              color: score === 'crit' ? 'var(--crit)' : score === 'warn' ? 'var(--warn)' : 'var(--ok)',
            }}
          >
            {scoreLabel}
          </div>
          {data && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Audited {relativeTime(data.ranAt)} · took {data.durationMs}ms
              {summary.acked > 0 && ` · ${summary.acked} acked`}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto', alignItems: 'center' }}>
          {SEV_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn ghost${filter === s ? ' active' : ''}`}
              onClick={() => setFilter(filter === s ? null : s)}
              style={{ padding: '6px 12px', minWidth: 80 }}
              aria-pressed={filter === s}
            >
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                marginRight: 7, verticalAlign: 'middle',
                background: SEV_COLOR[s],
              }} />
              {summary[s] || 0} {SEV_LABEL[s]}
            </button>
          ))}
          {isAdmin && (
            <button
              type="button"
              className="btn compact"
              onClick={() => loadAudit({ force: true })}
              disabled={running}
              style={{ marginLeft: 8 }}
            >
              {running ? 'Re-running…' : '↻ Re-run audit'}
            </button>
          )}
        </div>
      </div>

      <DiffStrip diff={data?.diff} />
      <HistoryCard history={history} range={historyRange} onRangeChange={setHistoryRange} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12, fontSize: 12, flexWrap: 'wrap' }}>
        {filter && (
          <span className="muted">
            Filtered to <strong>{SEV_LABEL[filter]}</strong> ({filtered.length} of {findings.length}).{' '}
            <button type="button" className="btn ghost" onClick={() => setFilter(null)} style={{ padding: '2px 8px', fontSize: 11 }}>
              Clear filter
            </button>
          </span>
        )}
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer', marginLeft: 'auto' }}>
          <input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} />
          <span className="muted">Show acknowledged ({summary.acked || 0})</span>
        </label>
      </div>

      {filtered.length === 0 && (
        <div className="card empty" style={{ padding: 32 }}>
          {filter ? 'No findings at this severity.' : (showAcked ? 'No findings.' : 'No findings — every check passed (or everything is acked).')}
        </div>
      )}
      {categories.map((cat) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div className="section-title">
            {cat}
            <span className="dim" style={{ fontSize: 11 }}>
              {byCategory[cat].length} finding{byCategory[cat].length === 1 ? '' : 's'}
            </span>
          </div>
          {byCategory[cat].map((f) => (
            <Finding
              key={f.id}
              f={f}
              isAdmin={isAdmin}
              onAck={ack}
              onUnack={unack}
              onSnooze={snooze}
              onRemediate={remediate}
              remediateBusy={remediateBusy}
            />
          ))}
        </div>
      ))}

      <AckDialog
        finding={ackTarget}
        onClose={() => setAckTarget(null)}
        onConfirm={confirmAck}
      />
    </div>
  );
}
