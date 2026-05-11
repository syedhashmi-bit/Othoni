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

async function runAction({ kind, target, actor, ip, dryRun = false } = {}) {
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
      metadata: { dryRun: true },
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
    result = await cfg.run({ target, actor, ip });
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
      stdoutSnippet: result.stdout.slice(0, AUDIT_SNIPPET_BYTES),
      stderrSnippet: result.stderr.slice(0, AUDIT_SNIPPET_BYTES),
    },
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
