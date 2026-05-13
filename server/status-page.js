'use strict';

// Public status page (v0.55). Opt-in via OTHONI_STATUS_PAGE_TOKEN; off by
// default. Mounted before the cookie-auth wall (same pattern as the
// Prometheus exporter and bulk export) so it can be reached without a
// dashboard session.
//
// Surface is intentionally tiny:
//   - One URL: GET /status?token=...
//   - Renders a static HTML page (server-side, no JS bundle required)
//   - Per-check: name, current up/down, last latency, 24h uptime %
//   - No metrics, no alerts, no admin controls
//
// Constant-time token comparison so a leaked token can't be brute-forced via
// timing. Returns 404 (not 401) when the token is wrong or unset — same
// behavior the Prometheus exporter uses to keep the endpoint invisible.

const crypto = require('crypto');
const checks = require('./checks');
const logger = require('./logger');

function getToken() {
  const t = (process.env.OTHONI_STATUS_PAGE_TOKEN || '').trim();
  return t || null;
}

function isEnabled() {
  return getToken() !== null;
}

// Constant-time string compare. crypto.timingSafeEqual requires equal-length
// buffers; pad the shorter side so leakage doesn't come from length-aware
// branching.
function constantEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  const max = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.alloc(max);
  const pb = Buffer.alloc(max);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLatency(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatUptime(pct) {
  if (pct == null) return '—';
  return `${pct.toFixed(2)}%`;
}

function formatRelative(ms) {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function render(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --card:#141823; --border:#1f2632;
          --text:#e6e9ef; --muted:#8a93a3; --ok:#3fb950; --crit:#f85149;
          --warn:#d29922; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 16px; font:14px/1.5 system-ui, -apple-system,
         "Segoe UI", sans-serif; background:var(--bg); color:var(--text);
         max-width: 760px; margin-inline:auto; }
  h1 { font-size:22px; margin:0 0 4px; font-weight:600; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:24px; }
  .summary { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .summary .pill { padding:4px 10px; border-radius:999px; font-size:12px;
                   font-weight:500; background:var(--card); border:1px solid var(--border); }
  .summary .pill.ok   { color:var(--ok);   border-color:rgba(63,185,80,.3); }
  .summary .pill.crit { color:var(--crit); border-color:rgba(248,81,73,.3); }
  .summary .pill.warn { color:var(--warn); }
  .check { background:var(--card); border:1px solid var(--border);
           border-radius:8px; padding:14px 16px; margin-bottom:8px;
           display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .check.down { border-color:rgba(248,81,73,.4); }
  .check .label { font-weight:500; font-size:15px; }
  .check .meta { color:var(--muted); font-size:12px; margin-top:2px; }
  .check .right { text-align:right; }
  .check .status { font-weight:600; }
  .check .status.up { color:var(--ok); }
  .check .status.down { color:var(--crit); }
  .check .status.pending { color:var(--muted); }
  .check .uptime { color:var(--muted); font-size:12px; margin-top:2px; }
  footer { color:var(--muted); font-size:11px; margin-top:32px; text-align:center; }
  footer a { color:var(--muted); text-decoration:none; }
</style>
</head>
<body>
${body}
<footer>othoni · public status page · auto-refresh every 30s</footer>
<script>
  // Plain auto-refresh — keeps the bundle empty and the surface boring.
  setTimeout(function () { location.reload(); }, 30000);
</script>
</body>
</html>`;
}

function renderError(message) {
  return render('Status', `<h1>Status</h1><p class="sub">${escHtml(message)}</p>`);
}

function handleRequest(req, res) {
  const expected = getToken();
  if (!expected) {
    return res.status(404).type('text/html').send(renderError('Not found.'));
  }
  const given = (req.query.token || '').trim();
  if (!constantEqual(given, expected)) {
    return res.status(404).type('text/html').send(renderError('Not found.'));
  }

  // Pull the current state. We use the checks module's in-memory list (always
  // fresh — the scheduler writes to it on every run). For per-check uptime
  // over a 24h window, hit getCheckStats which caches its own results.
  let list;
  try { list = checks.listChecks(); }
  catch (e) {
    logger.warn(`status: listChecks failed: ${e.message}`);
    return res.status(500).type('text/html').send(renderError('Could not load status right now.'));
  }
  const visible = list.filter((c) => c.enabled !== false);

  const summary = {
    total:    visible.length,
    up:       visible.filter((c) => c.lastUp === 1).length,
    down:     visible.filter((c) => c.lastUp === 0).length,
    pending:  visible.filter((c) => c.lastUp == null).length,
  };
  const allUp = summary.total > 0 && summary.up === summary.total;
  const anyDown = summary.down > 0;

  const headline = anyDown
    ? `<span class="pill crit">⚠ ${summary.down} down</span>`
    : (allUp ? `<span class="pill ok">✓ All systems operational</span>` : '');

  const rows = visible.map((c) => {
    let stats = null;
    try { stats = checks.getCheckStats(c.id, { range: '24h' }); }
    catch (_e) { /* stats are nice-to-have */ }
    const statusClass = c.lastUp === 1 ? 'up' : c.lastUp === 0 ? 'down' : 'pending';
    const statusLabel = c.lastUp === 1 ? 'Operational' : c.lastUp === 0 ? 'Down' : 'Pending';
    const uptimeLine = stats && stats.uptimePercent != null
      ? `<div class="uptime">${formatUptime(stats.uptimePercent)} uptime (24h)</div>`
      : '';
    const latencyLine = c.lastLatencyMs != null
      ? `<div class="meta">${escHtml(c.type)} · ${formatLatency(c.lastLatencyMs)} · ${escHtml(formatRelative(c.lastRunAt))}</div>`
      : `<div class="meta">${escHtml(c.type)}</div>`;
    return `<div class="check${c.lastUp === 0 ? ' down' : ''}">
  <div>
    <div class="label">${escHtml(c.label || c.id)}</div>
    ${latencyLine}
  </div>
  <div class="right">
    <div class="status ${statusClass}">${statusLabel}</div>
    ${uptimeLine}
  </div>
</div>`;
  }).join('\n');

  const empty = visible.length === 0
    ? `<p class="sub">No checks configured yet.</p>`
    : '';

  const html = render('Status', `
<h1>Status</h1>
<div class="sub">${visible.length} check${visible.length === 1 ? '' : 's'} · updated ${escHtml(new Date().toUTCString())}</div>
<div class="summary">${headline}</div>
${empty}
${rows}
`);

  res.status(200).type('text/html').send(html);
}

module.exports = { handleRequest, isEnabled };
