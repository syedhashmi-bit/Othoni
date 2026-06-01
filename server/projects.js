'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./collectors/exec');

const WWW_ROOT = process.env.OTHONI_PROJECTS_ROOT || '/var/www';
const SELF_UNIT = process.env.OTHONI_SELF_UNIT || 'othoni';
const CACHE_TTL_MS = 8_000;

// Config file: maps directory names to their systemd unit names when they differ.
// Format: { "pipsqueeze": "vpn-dashboard", "myapp": "myapp-server" }
const CONFIG_PATH = process.env.OTHONI_PROJECTS_CONFIG ||
  path.join(__dirname, '..', 'data', 'projects.json');

// Same pattern the systemd.restart action uses — covers all valid unit names.
const UNIT_NAME_RE = /^[A-Za-z0-9._@:\-]{1,128}$/;

let cache = null;
let cacheAt = 0;

// Returns { dirName: unitName } from the config file. Missing file = empty map.
function loadUnitMap() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* file absent or malformed — ignore */ }
  return {};
}

function listWwwDirs() {
  try {
    return fs.readdirSync(WWW_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && UNIT_NAME_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Candidate unit names to try for a directory, in priority order:
// an explicit config override wins; otherwise the exact directory name,
// then a lowercased variant (covers dir `Protek` → unit `protek`).
function unitCandidates(dir, unitMap) {
  const mapped = unitMap[dir];
  if (mapped && UNIT_NAME_RE.test(mapped)) return [mapped];
  const lower = dir.toLowerCase();
  return lower === dir ? [dir] : [dir, lower];
}

async function probeUnit(unit) {
  const r = await run(
    'systemctl',
    ['show', '-p', 'LoadState', '-p', 'ActiveState', '--value', unit],
    { timeout: 2000 }
  );
  if (!r.ok) return null;
  const [loadState = '', activeState = ''] = r.stdout.split('\n').map((s) => s.trim());
  if (loadState !== 'loaded') return null;
  let status = 'inactive';
  if (activeState === 'active')                                      status = 'active';
  else if (activeState === 'failed')                                 status = 'failed';
  else if (activeState === 'activating' || activeState === 'deactivating') status = activeState;
  return status;
}

async function checkUnit(dir, candidates) {
  for (const unit of candidates) {
    const status = await probeUnit(unit);
    if (status !== null) return { name: dir, unit, status };
  }
  return null;
}

async function getProjects({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const unitMap = loadUnitMap();
  const dirs = listWwwDirs();

  const entries = await Promise.all(
    dirs.map((dir) => checkUnit(dir, unitCandidates(dir, unitMap)))
  );

  const projects = entries.filter(Boolean);
  cache = { projects, root: WWW_ROOT };
  cacheAt = now;
  return cache;
}

// Look up the unit name for a given directory name, applying config overrides
// and the same case-insensitive fallback the scanner uses. Returns the loaded
// unit name (or the first candidate if none probe as loaded), or null if the
// directory is invalid.
async function resolveUnit(dir) {
  if (typeof dir !== 'string' || !UNIT_NAME_RE.test(dir)) return null;
  try {
    if (!fs.statSync(path.join(WWW_ROOT, dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const candidates = unitCandidates(dir, loadUnitMap());
  for (const unit of candidates) {
    if ((await probeUnit(unit)) !== null) return unit;
  }
  return candidates[0];
}

async function controlProject(name, action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    const e = new Error('action must be start, stop, or restart');
    e.code = 'invalid_action';
    throw e;
  }
  const unit = await resolveUnit(name);
  if (!unit) {
    const e = new Error(`not a known project: ${name}`);
    e.code = 'invalid_target';
    throw e;
  }
  // Stopping the dashboard itself would make it unreachable. Restart is fine.
  const selfUnits = new Set([SELF_UNIT, `${SELF_UNIT}.service`]);
  if (action === 'stop' && selfUnits.has(unit)) {
    const e = new Error('cannot stop the running othoni service');
    e.code = 'invalid_action';
    throw e;
  }
  cache = null;
  const startedAt = Date.now();
  const r = await run('systemctl', [action, unit], { timeout: 30_000 });
  return {
    ok: r.ok,
    action,
    name,
    unit,
    durationMs: Date.now() - startedAt,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.ok ? 0 : (typeof r.code === 'number' ? r.code : 1),
  };
}

module.exports = { getProjects, controlProject };
