'use strict';

// Pending package updates on this box (v0.80): what's waiting, which of it
// is security, whether a reboot is owed, and how fresh the package lists
// are. Read-only by design — othoni shows the command to run but never
// installs anything (README → Scope).
//
// Debian/Ubuntu via `apt list --upgradable`, RHEL-family via `dnf
// check-update`. Neither refreshes the package lists: the answer is only
// as new as the box's last `apt update` / dnf metadata refresh, which is
// why `listsRefreshedAt` is reported alongside.
//
// Refreshed every 10 minutes (and on demand, at most once a minute);
// each refresh records `updates.pending` / `updates.security` so alert
// rules can fire on them.

const fs = require('fs');
const path = require('path');
const { run } = require('./collectors/exec');
const history = require('./history');
const logger = require('./logger');

const REFRESH_MS = 10 * 60 * 1000;
const MIN_FORCED_GAP_MS = 60 * 1000;

let last = null;     // the latest result (see collect())
let inflight = null; // a refresh in progress, shared by concurrent callers
let timer = null;

// `name/suite1,suite2 newVersion arch [upgradable from: oldVersion]`
const APT_LINE = /^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from:\s*([^\]]+)\])?/;

function parseApt(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = APT_LINE.exec(line.trim());
    if (!m) continue;
    const suites = m[2].split(',');
    out.push({
      name: m[1],
      from: m[5] ? m[5].trim() : null,
      to: m[3],
      arch: m[4],
      source: suites.find((s) => /-security$/.test(s)) || suites[0],
      security: suites.some((s) => /-security$/.test(s)),
    });
  }
  return out;
}

// `name.arch  version  repo` rows; everything else (blank lines, the
// "Obsoleting Packages" block's indented rows) is skipped.
function parseDnf(stdout) {
  const out = [];
  let obsoleting = false;
  for (const line of stdout.split('\n')) {
    if (/^Obsoleting/i.test(line)) { obsoleting = true; continue; }
    if (obsoleting || !/^\S+\.\S+\s+\S+\s+\S+\s*$/.test(line)) continue;
    const [nameArch, to, source] = line.trim().split(/\s+/);
    const dot = nameArch.lastIndexOf('.');
    out.push({ name: nameArch.slice(0, dot), from: null, to, arch: nameArch.slice(dot + 1), source, security: false });
  }
  return out;
}

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

// When apt last downloaded package lists: the periodic stamp if
// apt.systemd.daily runs, else the newest Release file it fetched.
function aptListsRefreshedAt() {
  const stamp = mtimeMs('/var/lib/apt/periodic/update-success-stamp');
  let newest = null;
  try {
    for (const f of fs.readdirSync('/var/lib/apt/lists')) {
      if (!/Release$/.test(f)) continue;
      const t = mtimeMs(path.join('/var/lib/apt/lists', f));
      if (t && (!newest || t > newest)) newest = t;
    }
  } catch { /* no apt */ }
  const times = [stamp, newest].filter(Boolean);
  return times.length ? Math.max(...times) : null;
}

function rebootStatus() {
  for (const dir of ['/run', '/var/run']) {
    if (!fs.existsSync(`${dir}/reboot-required`)) continue;
    let packages = [];
    try {
      packages = fs.readFileSync(`${dir}/reboot-required.pkgs`, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* list is optional */ }
    return { required: true, packages: [...new Set(packages)] };
  }
  return { required: false, packages: [] };
}

// Whether unattended-upgrades is switched on (Debian/Ubuntu); null when it
// can't be told.
function autoUpdates() {
  try {
    const s = fs.readFileSync('/etc/apt/apt.conf.d/20auto-upgrades', 'utf8');
    return /APT::Periodic::Unattended-Upgrade\s+"1"/.test(s);
  } catch {
    return null;
  }
}

async function collect() {
  const checkedAt = Date.now();
  const apt = await run('apt', ['list', '--upgradable'], { timeout: 20000, env: { LC_ALL: 'C' } });
  if (apt.ok) {
    const packages = parseApt(apt.stdout);
    return {
      manager: 'apt',
      checkedAt,
      listsRefreshedAt: aptListsRefreshedAt(),
      packages,
      reboot: rebootStatus(),
      autoUpdates: autoUpdates(),
      command: 'sudo apt update && sudo apt upgrade',
    };
  }
  // dnf check-update exits 100 when updates exist, 0 when none.
  const dnf = await run('dnf', ['check-update', '-q'], { timeout: 60000 });
  if (dnf.ok || dnf.code === 100) {
    const packages = parseDnf(dnf.stdout);
    const sec = await run('dnf', ['-q', 'updateinfo', 'list', '--security', '--updates'], { timeout: 60000 });
    if (sec.ok) {
      const names = new Set(sec.stdout.split('\n').map((l) => l.trim().split(/\s+/)[2]).filter(Boolean)
        .map((nvra) => nvra.replace(/-[^-]+-[^-]+$/, '')));
      for (const p of packages) p.security = names.has(p.name);
    }
    return {
      manager: 'dnf', checkedAt, listsRefreshedAt: null, packages,
      reboot: rebootStatus(), autoUpdates: null, command: 'sudo dnf upgrade',
    };
  }
  return { manager: null, checkedAt, listsRefreshedAt: null, packages: [], reboot: rebootStatus(), autoUpdates: null, command: null,
    error: 'No supported package manager found (apt or dnf).' };
}

function summarize(r) {
  const security = r.packages.filter((p) => p.security).length;
  // Security first, then by name.
  r.packages.sort((a, b) => (b.security - a.security) || a.name.localeCompare(b.name));
  r.counts = { total: r.packages.length, security };
  return r;
}

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      last = summarize(await collect());
      if (last.manager) {
        history.insertSample('updates.pending', last.counts.total, last.checkedAt);
        history.insertSample('updates.security', last.counts.security, last.checkedAt);
      }
    } catch (e) {
      logger.warn(`updates: check failed: ${e.message}`);
    } finally {
      inflight = null;
    }
    return last;
  })();
  return inflight;
}

// The latest result, refreshed first when it's stale (or when asked to,
// at most once a minute).
async function get({ force = false } = {}) {
  const age = last ? Date.now() - last.checkedAt : Infinity;
  if (!last || age > REFRESH_MS || (force && age > MIN_FORCED_GAP_MS)) await refresh();
  return last;
}

// For alert rules: null until the first check finishes ("no data").
function getLast() {
  return last;
}

function start() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { get, getLast, start, stop, refresh, parseApt, parseDnf };
