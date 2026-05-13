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

async function checkUnit(dir, unit) {
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
  return { name: dir, unit, status };
}

async function getProjects() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const unitMap = loadUnitMap();
  const dirs = listWwwDirs();

  const entries = await Promise.all(
    dirs.map((dir) => {
      const unit = (unitMap[dir] && UNIT_NAME_RE.test(unitMap[dir])) ? unitMap[dir] : dir;
      return checkUnit(dir, unit);
    })
  );

  const projects = entries.filter(Boolean);
  cache = { projects, root: WWW_ROOT };
  cacheAt = now;
  return cache;
}

// Look up the unit name for a given directory name, applying config overrides.
function resolveUnit(dir) {
  if (typeof dir !== 'string' || !UNIT_NAME_RE.test(dir)) return null;
  try {
    if (!fs.statSync(path.join(WWW_ROOT, dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const unitMap = loadUnitMap();
  const unit = (unitMap[dir] && UNIT_NAME_RE.test(unitMap[dir])) ? unitMap[dir] : dir;
  return unit;
}

async function controlProject(name, action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    const e = new Error('action must be start, stop, or restart');
    e.code = 'invalid_action';
    throw e;
  }
  const unit = resolveUnit(name);
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
