'use strict';

// Action framework (v0.31.0). Off by default — enable with
// `OTHONI_ACTIONS_ENABLED=true` in .env. Each "action kind" is a small
// registry entry with a target validator + an async runner; this module
// adds the cross-cutting concerns (audit logging, per-actor concurrency
// guard, stdout/stderr capture with a cap, structured result shape).
//
// Concrete actions land in subsequent releases:
//   v0.32.0 — systemd service restart
//   v0.33.0 — Docker container start/stop/restart
//   v0.34.0 — process signal (SIGTERM by PID)
//
// v0.31.0 itself ships a single built-in `noop` kind so the framework
// is testable end-to-end without any system-mutating code paths.

const logger = require('./logger');
const audit = require('./audit');
const actionHistory = require('./action-history');

// Read at module-load so changing the env requires a restart — that's
// intentional. An operator should never be able to flip actions on for
// a single request via a header or query param.
const ENABLED = (() => {
  const v = process.env.OTHONI_ACTIONS_ENABLED;
  if (v == null) return false;
  return v === 'true' || v === '1';
})();

// Per-actor concurrency lock. The map value is the timestamp the action
// started; we only use it for "started at" reporting in the error
// message. Locks are released in a `finally` block so a thrown runner
// still releases.
const running = new Map();

const KINDS = new Map();

// Output cap — we capture this much of stdout/stderr per stream into the
// returned result and snippet a chunk into the audit metadata. Anything
// larger gets truncated with a "... (N bytes truncated)" marker so a
// runaway command can't bloat the response.
const OUTPUT_CAP_BYTES = 8 * 1024;
const AUDIT_SNIPPET_BYTES = 200;

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length - max} bytes truncated)`;
}

function isEnabled() {
  return ENABLED;
}

function listKinds() {
  return Array.from(KINDS.entries()).map(([kind, cfg]) => ({
    kind,
    description: cfg.description,
    requiresConfirmation: !!cfg.requiresConfirmation,
  }));
}

function register(kind, cfg) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9._-]{0,40}$/.test(kind)) {
    throw new Error(`invalid action kind: ${kind}`);
  }
  if (KINDS.has(kind)) {
    throw new Error(`action kind "${kind}" already registered`);
  }
  if (typeof cfg.run !== 'function') {
    throw new Error(`action "${kind}" missing run() function`);
  }
  KINDS.set(kind, cfg);
}

function actorKey(actor) {
  return actor || '-anon-';
}

function isRunning(actor) {
  return running.has(actorKey(actor));
}

async function runAction({ kind, target, actor, ip, dryRun = false, params = {} } = {}) {
  if (!ENABLED) {
    const err = new Error('actions are disabled (set OTHONI_ACTIONS_ENABLED=true and restart)');
    err.code = 'actions_disabled';
    throw err;
  }
  const cfg = KINDS.get(kind);
  if (!cfg) {
    const err = new Error(`unknown action kind: ${kind}`);
    err.code = 'unknown_kind';
    throw err;
  }
  if (cfg.targetValidator && !cfg.targetValidator(target)) {
    const err = new Error(`invalid target for ${kind}: ${target}`);
    err.code = 'invalid_target';
    throw err;
  }
  if (cfg.paramsValidator && !cfg.paramsValidator(params || {})) {
    const err = new Error(`invalid params for ${kind}: ${JSON.stringify(params)}`);
    err.code = 'invalid_params';
    throw err;
  }

  const ak = actorKey(actor);
  if (running.has(ak)) {
    const err = new Error(`another action is already running for actor "${actor || '-'}"`);
    err.code = 'busy';
    throw err;
  }

  const auditName = cfg.auditName || `action.${kind}`;

  if (dryRun) {
    audit.log({
      actor: actor || null,
      action: auditName,
      target: target || null,
      ip: ip || null,
      metadata: { dryRun: true, params: params || {} },
    });
    actionHistory.record({
      actor: actor || null,
      kind,
      target: target || null,
      ip: ip || null,
      ok: true,
      exitCode: 0,
      durationMs: 0,
      dryRun: true,
      stdout: '(dry run — no action taken)',
      stderr: '',
      params: params || {},
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: '(dry run — no action taken)',
      stderr: '',
      durationMs: 0,
      dryRun: true,
    };
  }

  running.set(ak, Date.now());
  const startedAt = Date.now();
  let result;
  try {
    result = await cfg.run({ target, actor, ip, params });
    // Normalize the shape — runners can omit fields and we fill in.
    result = {
      ok: !!result.ok,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : (result.ok ? 0 : 1),
      stdout: truncate(result.stdout || '', OUTPUT_CAP_BYTES),
      stderr: truncate(result.stderr || '', OUTPUT_CAP_BYTES),
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : (Date.now() - startedAt),
    };
  } catch (e) {
    logger.warn(`actions: ${kind} runner threw: ${e.message}`);
    result = {
      ok: false,
      exitCode: e.code === 'ETIMEDOUT' ? 124 : 1,
      stdout: '',
      stderr: truncate((e && e.message) || String(e), OUTPUT_CAP_BYTES),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    running.delete(ak);
  }

  audit.log({
    actor: actor || null,
    action: auditName,
    target: target || null,
    ip: ip || null,
    metadata: {
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      params: params || {},
      stdoutSnippet: result.stdout.slice(0, AUDIT_SNIPPET_BYTES),
      stderrSnippet: result.stderr.slice(0, AUDIT_SNIPPET_BYTES),
    },
  });
  // Durable record in action_history with full (up to 8 KB) stdout/stderr.
  actionHistory.record({
    actor: actor || null,
    kind,
    target: target || null,
    ip: ip || null,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    dryRun: false,
    stdout: result.stdout,
    stderr: result.stderr,
    params: params || {},
  });

  return result;
}

// ---------- systemd.restart ----------
// Restart a systemd unit. Whitelist-only — defaults to the same list
// that the Services page already shows status for, so an operator who
// has agreed to monitor a unit has implicitly opted in to letting it
// be restarted from the dashboard. `OTHONI_ACTION_UNIT_WHITELIST` env
// var overrides (comma-separated). Restarting the running othoni
// service itself is refused outright — that'd kill the response
// mid-flight. `OTHONI_SELF_UNIT` env var lets an operator who renamed
// the unit point the guard at the right name.
const { DEFAULT_SERVICES } = require('./collectors/services');
const { run: execRun } = require('./collectors/exec');

const UNIT_WHITELIST = (() => {
  const v = process.env.OTHONI_ACTION_UNIT_WHITELIST;
  if (!v) return new Set(DEFAULT_SERVICES);
  return new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
})();

const SELF_UNIT = process.env.OTHONI_SELF_UNIT || 'othoni';
const SELF_UNITS = new Set([SELF_UNIT, `${SELF_UNIT}.service`]);

const UNIT_NAME_RE = /^[A-Za-z0-9._@:\-]{1,128}$/;

register('systemd.restart', {
  description: 'Restart a systemd unit (whitelist-only).',
  auditName: 'action.systemd.restart',
  requiresConfirmation: true,
  targetValidator: (t) => {
    if (typeof t !== 'string') return false;
    if (!UNIT_NAME_RE.test(t)) return false;
    if (SELF_UNITS.has(t)) return false;
    return UNIT_WHITELIST.has(t);
  },
  async run({ target }) {
    const startedAt = Date.now();
    const r = await execRun('systemctl', ['restart', target], { timeout: 30_000 });
    return {
      ok: r.ok,
      exitCode: r.ok
        ? 0
        : (r.code === 'ETIMEDOUT' ? 124 : (typeof r.code === 'number' ? r.code : 1)),
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      durationMs: Date.now() - startedAt,
    };
  },
});

// ---------- docker.start / stop / restart ----------
// Docker containers are dynamic so a fixed whitelist doesn't fit. The
// operator's OTHONI_ACTIONS_ENABLED opt-in covers consent at the surface
// level; per-container consent comes from the UI button placement (only
// state-valid actions get rendered). Self-protect via
// OTHONI_SELF_CONTAINER env var (e.g. when running the dashboard
// itself in Docker — defaults unset).

// Docker container name/id regex matches the docker daemon's rules
// (alphanumeric, underscore, hyphen, period — 64-char id or up to
// 255-char name). Bare-minimum sanitization since the value goes to
// execFile (no shell), but rejecting bad input early gives clearer
// errors.
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const SELF_CONTAINER = (process.env.OTHONI_SELF_CONTAINER || '').trim();

function makeContainerTargetValidator() {
  return (t) => {
    if (typeof t !== 'string') return false;
    if (!CONTAINER_NAME_RE.test(t)) return false;
    if (SELF_CONTAINER && (t === SELF_CONTAINER)) return false;
    return true;
  };
}

async function runDocker(verb, target) {
  const startedAt = Date.now();
  const r = await execRun('docker', [verb, target], { timeout: 30_000 });
  return {
    ok: r.ok,
    exitCode: r.ok
      ? 0
      : (r.code === 'ETIMEDOUT' ? 124 : (typeof r.code === 'number' ? r.code : 1)),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    durationMs: Date.now() - startedAt,
  };
}

register('docker.start', {
  description: 'Start a stopped Docker container.',
  auditName: 'action.docker.start',
  requiresConfirmation: true,
  targetValidator: makeContainerTargetValidator(),
  async run({ target }) { return runDocker('start', target); },
});

register('docker.stop', {
  description: 'Stop a running Docker container (SIGTERM, then SIGKILL after 10s).',
  auditName: 'action.docker.stop',
  requiresConfirmation: true,
  targetValidator: makeContainerTargetValidator(),
  async run({ target }) { return runDocker('stop', target); },
});

register('docker.restart', {
  description: 'Restart a Docker container.',
  auditName: 'action.docker.restart',
  requiresConfirmation: true,
  targetValidator: makeContainerTargetValidator(),
  async run({ target }) { return runDocker('restart', target); },
});

// ---------- process.signal ----------
// Send a signal to a process by PID. Allowed signals are a small safe
// set (no SIGSTOP / SIGCONT — process freeze isn't something the
// dashboard should help with). Defaults to TERM. KILL requires the UI
// to make a stronger confirmation gesture, but the framework treats
// both identically — operator consent is upstream.
//
// Self-protection layers, applied at validation time before any signal
// is sent:
//   - Refuses PID 1 (init / systemd-as-pid1) outright.
//   - Refuses the dashboard's own PID (process.pid).
//   - Refuses any process whose /proc/<pid>/comm matches the regex in
//     OTHONI_PROCESS_GUARD. Defaults to ^(systemd|init|sshd|nginx)$ —
//     killing any of those breaks ingress to othoni. Operators can
//     override or remove via env.

const fs = require('fs');
const path = require('path');

const SAFE_SIGNALS = new Set(['TERM', 'INT', 'HUP', 'USR1', 'USR2', 'KILL']);
const SELF_PID = process.pid;
const PROCESS_GUARD_RE = (() => {
  const raw = process.env.OTHONI_PROCESS_GUARD;
  if (raw === '' || raw === 'none') return null;
  try {
    return new RegExp(raw || '^(systemd|init|sshd|nginx)$');
  } catch (e) {
    logger.warn(`actions: bad OTHONI_PROCESS_GUARD regex (${e.message}); using default`);
    return /^(systemd|init|sshd|nginx)$/;
  }
})();

function readProcComm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

function validateProcessTarget(t) {
  if (typeof t !== 'string') return false;
  if (!/^[1-9][0-9]{0,6}$/.test(t)) return false;     // 1..9999999
  const pid = parseInt(t, 10);
  if (pid === 1) return false;
  if (pid === SELF_PID) return false;
  // Reject when /proc/<pid> doesn't exist — the process is gone or
  // wasn't ours to find. UI gets a clean error rather than an
  // unhelpful ESRCH.
  const comm = readProcComm(pid);
  if (comm == null) return false;
  if (PROCESS_GUARD_RE && PROCESS_GUARD_RE.test(comm)) return false;
  return true;
}

function validateProcessParams(p) {
  if (p == null || typeof p !== 'object') return true; // empty → TERM default
  if (p.signal == null) return true;
  if (typeof p.signal !== 'string') return false;
  return SAFE_SIGNALS.has(p.signal);
}

register('process.signal', {
  description: 'Send a signal to a process by PID. params.signal defaults to TERM (also accepts INT/HUP/USR1/USR2/KILL).',
  auditName: 'action.process.signal',
  requiresConfirmation: true,
  targetValidator: validateProcessTarget,
  paramsValidator: validateProcessParams,
  async run({ target, params }) {
    const startedAt = Date.now();
    const pid = parseInt(target, 10);
    // SAFE_SIGNALS holds the bare short names ("TERM", "KILL", ...) — the
    // operator-facing shape. Node's process.kill expects "SIGTERM" etc.,
    // so translate at the boundary.
    const shortSignal = (params && params.signal) || 'TERM';
    const sigName = shortSignal.startsWith('SIG') ? shortSignal : `SIG${shortSignal}`;
    try {
      process.kill(pid, sigName);
      const comm = readProcComm(pid);  // may have just exited
      return {
        ok: true,
        exitCode: 0,
        stdout: `sent ${sigName} to PID ${pid}${comm ? ` (${comm})` : ''}`,
        stderr: '',
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      return {
        ok: false,
        exitCode: e.code === 'ESRCH' ? 3 : (e.code === 'EPERM' ? 1 : 1),
        stdout: '',
        stderr: e.message || String(e),
        durationMs: Date.now() - startedAt,
      };
    }
  },
});

// Surface the resolved whitelist on the kinds listing so the UI can
// disable the restart button for non-whitelisted units rather than
// having the user click and get a 400.
function listKindsWithDetail() {
  return listKinds().map((k) => {
    if (k.kind === 'systemd.restart') {
      return { ...k, allowedTargets: Array.from(UNIT_WHITELIST).sort() };
    }
    return k;
  });
}

// ---------- security.remediate ----------
// One-click fixes for select audit findings. Each remediation writes a
// scoped sshd_config.d drop-in (not the main sshd_config — that file
// stays untouched so distro upgrades don't conflict) and reloads sshd.
// The drop-in file path is deterministic so re-running just overwrites.
//
// Safe set: SSH-only directives that turn risky-on into safe-off.
//   - ssh.disable-root-login       → PermitRootLogin no
//   - ssh.disable-password-auth    → PasswordAuthentication no  /  KbdInteractive no
//   - ssh.disable-empty-passwords  → PermitEmptyPasswords no
//
// Refusal is conservative: if /etc/ssh/sshd_config.d is missing or
// sshd isn't reachable via systemd, we bail out with a clear error
// instead of silently writing somewhere unexpected.

const SSH_DROPIN_DIR = '/etc/ssh/sshd_config.d';
const SSH_DROPIN_FILE = path.join(SSH_DROPIN_DIR, '99-othoni-hardening.conf');

// Each target maps to one or more `Directive value` lines. We accumulate
// every line we've ever written into the drop-in, so applying a second
// remediation doesn't clobber a previous one.
const SSH_REMEDIATIONS = {
  'ssh.disable-root-login':      'PermitRootLogin no',
  'ssh.disable-password-auth':   'PasswordAuthentication no\nKbdInteractiveAuthentication no',
  'ssh.disable-empty-passwords': 'PermitEmptyPasswords no',
};

function readExistingDropin() {
  try { return fs.readFileSync(SSH_DROPIN_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

// Merge a directive into the drop-in: if the directive name is already
// present (anywhere) replace that line; otherwise append.
function mergeDirectives(existing, addLines) {
  const existingLines = existing.split('\n');
  for (const line of addLines.split('\n')) {
    const directive = line.split(/\s+/)[0];
    let replaced = false;
    for (let i = 0; i < existingLines.length; i++) {
      const trimmed = existingLines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const name = trimmed.split(/\s+/)[0];
      if (name === directive) { existingLines[i] = line; replaced = true; break; }
    }
    if (!replaced) existingLines.push(line);
  }
  // Strip trailing empties.
  while (existingLines.length && existingLines[existingLines.length - 1].trim() === '') {
    existingLines.pop();
  }
  return existingLines.join('\n') + '\n';
}

async function runSshRemediation(target, startedAt) {
  // Sanity-check the drop-in dir exists. Modern Ubuntu/Debian sshd
  // includes /etc/ssh/sshd_config.d/*.conf by default; if it's not
  // there, refuse rather than write a file that won't take effect.
  if (!fs.existsSync(SSH_DROPIN_DIR)) {
    return {
      ok: false, exitCode: 2,
      stdout: '',
      stderr: `refused: ${SSH_DROPIN_DIR} does not exist (sshd may not be configured to read drop-ins)`,
      durationMs: Date.now() - startedAt,
    };
  }
  const addLines = SSH_REMEDIATIONS[target];
  let existing;
  try { existing = readExistingDropin(); }
  catch (e) {
    return {
      ok: false, exitCode: 1, stdout: '',
      stderr: `read ${SSH_DROPIN_FILE} failed: ${e.message}`,
      durationMs: Date.now() - startedAt,
    };
  }
  const next = mergeDirectives(existing, addLines);
  const header = '# Managed by othoni — security.remediate drop-in.\n# Edit /etc/ssh/sshd_config or another drop-in to override.\n';
  const body = next.startsWith('#') ? next : header + next;
  try {
    const tmp = `${SSH_DROPIN_FILE}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    fs.renameSync(tmp, SSH_DROPIN_FILE);
  } catch (e) {
    return {
      ok: false, exitCode: 1, stdout: '',
      stderr: `write ${SSH_DROPIN_FILE} failed: ${e.message}`,
      durationMs: Date.now() - startedAt,
    };
  }
  // Validate config before restart. `sshd -t` exits non-zero on
  // bad config without touching the running daemon — critical so
  // we never apply a config that would lock the operator out.
  const test = await execRun('sshd', ['-t'], { timeout: 5000 });
  if (!test.ok) {
    return {
      ok: false, exitCode: typeof test.code === 'number' ? test.code : 1,
      stdout: '',
      stderr: `sshd config validation failed (NOT reloaded):\n${test.stderr || ''}`,
      durationMs: Date.now() - startedAt,
    };
  }
  const reload = await execRun('systemctl', ['reload', 'ssh'], { timeout: 5000 });
  // On older systems the unit is named `sshd`; fall back if reload-ssh
  // didn't find it.
  let reloadResult = reload;
  if (!reload.ok && /Unit (?:ssh\.service)? not found/i.test(reload.stderr || '')) {
    reloadResult = await execRun('systemctl', ['reload', 'sshd'], { timeout: 5000 });
  }
  return {
    ok: reloadResult.ok,
    exitCode: reloadResult.ok ? 0 : (typeof reloadResult.code === 'number' ? reloadResult.code : 1),
    stdout: `Wrote ${SSH_DROPIN_FILE} (target=${target}).\n${reloadResult.stdout || ''}`,
    stderr: reloadResult.stderr || '',
    durationMs: Date.now() - startedAt,
  };
}

// ---------- ufw.enable remediation ----------
// Enable the ufw firewall — but ONLY after explicitly allowing every
// SSH port the running sshd is bound to. ufw defaults to deny-incoming,
// so enabling it without that step would drop the operator's own
// connection. This mirrors the SSH set's `sshd -t`-before-reload gate:
// the lock-out-prevention step runs BEFORE the irreversible one, and if
// it fails we refuse to enable at all.

// Effective SSH ports from `sshd -T` (the running config, not the file).
// Falls back to 22 if sshd can't be queried so we never enable with an
// empty allowlist.
async function getSshPorts() {
  const ports = new Set();
  const r = await execRun('sshd', ['-T'], { timeout: 5000 });
  if (r.ok && r.stdout) {
    for (const line of r.stdout.split('\n')) {
      const m = /^port\s+(\d{1,5})$/i.exec(line.trim());
      if (m) {
        const p = parseInt(m[1], 10);
        if (p >= 1 && p <= 65535) ports.add(String(p));
      }
    }
  }
  if (ports.size === 0) ports.add('22');
  return [...ports];
}

async function runUfwEnable(startedAt) {
  // Confirm ufw is installed — a missing binary spawns ENOENT.
  const probe = await execRun('ufw', ['status'], { timeout: 5000 });
  if (!probe.ok && (probe.code === 'ENOENT' || /ENOENT|not found/i.test(probe.stderr || ''))) {
    return {
      ok: false, exitCode: 2, stdout: '',
      stderr: 'refused: ufw is not installed (install with `apt install ufw` first)',
      durationMs: Date.now() - startedAt,
    };
  }
  // Lock-out prevention: allow every SSH port BEFORE enabling.
  const ports = await getSshPorts();
  const log = [];
  for (const port of ports) {
    const allow = await execRun('ufw', ['allow', `${port}/tcp`], { timeout: 5000 });
    log.push(`ufw allow ${port}/tcp → ${allow.ok ? 'ok' : 'FAILED'}`);
    if (!allow.ok) {
      return {
        ok: false, exitCode: typeof allow.code === 'number' ? allow.code : 1,
        stdout: log.join('\n'),
        stderr: `refused to enable: could not allow SSH port ${port}/tcp first (lock-out risk):\n${allow.stderr || ''}`,
        durationMs: Date.now() - startedAt,
      };
    }
  }
  // Now safe to enable. --force skips the interactive y/n confirmation.
  const enable = await execRun('ufw', ['--force', 'enable'], { timeout: 10000 });
  log.push(`ufw --force enable → ${enable.ok ? 'ok' : 'failed'}`);
  return {
    ok: enable.ok,
    exitCode: enable.ok ? 0 : (typeof enable.code === 'number' ? enable.code : 1),
    stdout: `${log.join('\n')}\n${enable.stdout || ''}`.trim(),
    stderr: enable.stderr || '',
    durationMs: Date.now() - startedAt,
  };
}

// Every target the action accepts: the SSH drop-in set plus ufw.enable.
const VALID_REMEDIATIONS = new Set([...Object.keys(SSH_REMEDIATIONS), 'ufw.enable']);

register('security.remediate', {
  description: 'Apply a scoped security hardening fix: an SSH drop-in + reload, or enable the ufw firewall after allowing SSH.',
  auditName: 'action.security.remediate',
  requiresConfirmation: true,
  targetValidator: (t) => typeof t === 'string' && VALID_REMEDIATIONS.has(t),
  async run({ target }) {
    const startedAt = Date.now();
    if (target === 'ufw.enable') return runUfwEnable(startedAt);
    return runSshRemediation(target, startedAt);
  },
});

// ---------- built-in: noop ----------
// Framework smoke-test kind. Always succeeds; optional `target` like
// "200ms" sleeps that long so the concurrency-lock path is exercisable.
register('noop', {
  description: 'No-op (framework test). Target may be e.g. "200ms" to sleep.',
  auditName: 'action.noop',
  targetValidator: (t) => t == null || typeof t === 'string',
  async run({ target }) {
    const startedAt = Date.now();
    let sleepMs = 0;
    if (target && /^\d+ms$/.test(target)) {
      sleepMs = Math.min(5000, parseInt(target, 10));
    }
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    return {
      ok: true,
      exitCode: 0,
      stdout: `noop ran in ${Date.now() - startedAt}ms`,
      stderr: '',
      durationMs: Date.now() - startedAt,
    };
  },
});

module.exports = {
  runAction, listKinds, listKindsWithDetail, isEnabled, isRunning, register,
};
