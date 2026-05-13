'use strict';

// Security audit (v0.54). Read-only checks across the VPS surface:
// network ports, SSH configuration, firewall presence, OS package
// updates, and authentication state. Each check is isolated — a
// failure in one (e.g. ufw not installed) doesn't break the others.
//
// All checks read state from /proc or run common binaries with
// short timeouts; nothing here writes, sends network traffic, or
// otherwise modifies the system. The othoni service typically runs
// as root, so config files like /etc/ssh/sshd_config and /var/log/btmp
// are readable; checks that need root degrade gracefully when not.
//
// Results are cached for AUDIT_CACHE_TTL_MS so repeated polls don't
// re-shell out 20 commands. A `force: true` argument bypasses the
// cache (used by the "Re-run" button in the UI).

const fs = require('fs');
const { run } = require('./collectors/exec');
const { getConnections } = require('./collectors/connections');
const logger = require('./logger');

const AUDIT_CACHE_TTL_MS = 60_000;
let cache = null;
let cacheAt = 0;

// Severity ordering for the summary. The page sorts findings worst-first.
const SEV_RANK = { crit: 0, warn: 1, info: 2, ok: 3 };

// ---------- Ports ----------
//
// We already enumerate listening sockets in collectors/connections.js,
// which reads /proc/net/{tcp,tcp6,udp,udp6}. Re-use that here instead
// of shelling out to ss/lsof — same data, lower overhead.

// Well-known ports that are particularly risky when exposed publicly.
// The user may legitimately need some of these open; we surface the
// finding so they confirm it's intentional.
const RISKY_PORTS = {
  23:    { name: 'Telnet',         severity: 'crit', why: 'Plaintext authentication; deprecated. Use SSH instead.' },
  21:    { name: 'FTP',            severity: 'warn', why: 'Plaintext credentials. Prefer SFTP (SSH) or FTPS.' },
  25:    { name: 'SMTP',           severity: 'info', why: 'Mail server — make sure it does not relay openly.' },
  135:   { name: 'RPC',            severity: 'crit', why: 'Windows RPC — should never face the internet.' },
  139:   { name: 'NetBIOS',        severity: 'crit', why: 'SMB over NetBIOS — should never face the internet.' },
  445:   { name: 'SMB',            severity: 'crit', why: 'SMB over TCP — should never face the internet.' },
  1433:  { name: 'MS-SQL',         severity: 'warn', why: 'Database; should be firewalled to known clients.' },
  2375:  { name: 'Docker (no TLS)',severity: 'crit', why: 'Unauthenticated remote root execution. Use TLS (2376) or socket.' },
  3306:  { name: 'MySQL',          severity: 'warn', why: 'Database; should be firewalled to known clients.' },
  3389:  { name: 'RDP',            severity: 'warn', why: 'Remote Desktop — heavily scanned; gate with VPN/firewall.' },
  5432:  { name: 'PostgreSQL',     severity: 'warn', why: 'Database; should be firewalled to known clients.' },
  5984:  { name: 'CouchDB',        severity: 'warn', why: 'Old versions had auth bypass; firewall it.' },
  6379:  { name: 'Redis',          severity: 'warn', why: 'Often no auth by default. Bind 127.0.0.1 or set requirepass.' },
  9200:  { name: 'Elasticsearch',  severity: 'warn', why: 'Document store; should not be public.' },
  11211: { name: 'Memcached',      severity: 'warn', why: 'UDP variant can be used in DDoS amplification.' },
  27017: { name: 'MongoDB',        severity: 'warn', why: 'Database; should be firewalled to known clients.' },
};

function isPublicBind(addr) {
  // The connections collector formats each listening entry's
  // addresses as `IP (proto)`, e.g. `0.0.0.0 (tcp)` / `:: (tcp6)`.
  // Anything that's not 127.x or ::1 is reachable from outside.
  return /^0\.0\.0\.0\b/.test(addr) || /^::\b/.test(addr) || (!/^127\./.test(addr) && !/^::1\b/.test(addr));
}

async function auditPorts() {
  const findings = [];
  let conn;
  try { conn = await getConnections(); }
  catch (e) {
    return [{ id: 'ports-error', severity: 'info', category: 'Network',
      title: 'Could not enumerate listening ports', detail: e.message }];
  }
  const listening = conn.listening || [];

  const publicPorts = [];
  const localPorts = [];
  for (const l of listening) {
    const anyPublic = (l.addresses || []).some(isPublicBind);
    if (anyPublic) publicPorts.push(l);
    else localPorts.push(l);
  }

  // Per-port risk flags. Each risky port that's exposed publicly gets
  // its own finding so the user sees the specific service named.
  for (const p of publicPorts) {
    const risk = RISKY_PORTS[p.port];
    if (!risk) continue;
    findings.push({
      id: `port-risky-${p.port}`,
      severity: risk.severity,
      category: 'Network',
      title: `${risk.name} exposed on port ${p.port}/${p.protocol}`,
      detail: risk.why,
      evidence: (p.addresses || []).join(', '),
    });
  }

  // Big-picture summary — useful even when no risky ports are open.
  findings.push({
    id: 'ports-summary',
    severity: publicPorts.length > 10 ? 'warn' : 'info',
    category: 'Network',
    title: `${publicPorts.length} public port(s), ${localPorts.length} localhost-only`,
    detail: publicPorts.length === 0
      ? 'No ports listening on a public interface.'
      : `${publicPorts.length} listener(s) reachable from the internet (0.0.0.0 / ::). ${publicPorts.length > 10 ? 'Large attack surface — consider firewalling unnecessary services.' : 'Verify each is intentional.'}`,
    evidence: publicPorts.map((p) => `${p.port}/${p.protocol}`).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(', ') || null,
  });

  return findings;
}

// ---------- SSH ----------
//
// Parse /etc/ssh/sshd_config and flag risky directives. We respect
// commented-out lines and `Match` blocks (we only consider directives
// at the top level — `Match`-scoped overrides are out of scope for v1).

function parseSshConfig(text) {
  const directives = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Once we hit a Match block, ignore everything below — those are
    // conditional overrides and reading them correctly requires
    // simulating the matcher.
    if (/^match\s+/i.test(line)) break;
    const m = line.match(/^(\S+)\s+(.+?)$/);
    if (!m) continue;
    const [, key, val] = m;
    // First directive wins per OpenSSH semantics.
    if (!(key.toLowerCase() in directives)) {
      directives[key.toLowerCase()] = val.trim();
    }
  }
  return directives;
}

async function auditSsh() {
  const findings = [];
  let text;
  try { text = fs.readFileSync('/etc/ssh/sshd_config', 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      findings.push({ id: 'ssh-not-installed', severity: 'info', category: 'SSH',
        title: 'No SSH server config found', detail: '/etc/ssh/sshd_config does not exist on this host.' });
    } else {
      findings.push({ id: 'ssh-unreadable', severity: 'info', category: 'SSH',
        title: 'SSH config unreadable', detail: `Cannot read /etc/ssh/sshd_config: ${e.code || e.message}.` });
    }
    return findings;
  }
  const d = parseSshConfig(text);
  const permitRoot = (d['permitrootlogin'] || '').toLowerCase();
  const passAuth   = (d['passwordauthentication'] || '').toLowerCase();
  const emptyPass  = (d['permitemptypasswords'] || '').toLowerCase();
  const port       = d['port'] || '22';
  const x11        = (d['x11forwarding'] || '').toLowerCase();

  // PermitRootLogin. OpenSSH 7.0+ defaults to "prohibit-password"
  // (key-only root login). Older distros may still default to "yes".
  if (permitRoot === 'yes') {
    findings.push({
      id: 'ssh-root-yes', severity: 'crit', category: 'SSH',
      title: 'Root SSH login is enabled with full access',
      detail: 'Set `PermitRootLogin no` (or at minimum `prohibit-password`) and use a regular user with sudo.',
      evidence: `PermitRootLogin ${d['permitrootlogin']}`,
    });
  } else if (permitRoot === 'no') {
    findings.push({
      id: 'ssh-root-no', severity: 'ok', category: 'SSH',
      title: 'Root SSH login is disabled',
    });
  } else if (permitRoot === 'prohibit-password' || permitRoot === 'without-password') {
    findings.push({
      id: 'ssh-root-key', severity: 'ok', category: 'SSH',
      title: 'Root SSH login is key-only (prohibit-password)',
    });
  } else {
    findings.push({
      id: 'ssh-root-default', severity: 'info', category: 'SSH',
      title: 'PermitRootLogin not explicitly set',
      detail: 'Using OpenSSH default (typically prohibit-password on modern systems, but worth setting explicitly).',
    });
  }

  if (passAuth === 'yes') {
    findings.push({
      id: 'ssh-pass-auth', severity: 'warn', category: 'SSH',
      title: 'Password authentication is enabled',
      detail: 'Password auth is vulnerable to brute-force. Use SSH keys exclusively (`PasswordAuthentication no`).',
      evidence: 'PasswordAuthentication yes',
    });
  } else if (passAuth === 'no') {
    findings.push({
      id: 'ssh-pass-no', severity: 'ok', category: 'SSH',
      title: 'Password auth disabled (SSH keys only)',
    });
  }

  if (emptyPass === 'yes') {
    findings.push({
      id: 'ssh-empty-pass', severity: 'crit', category: 'SSH',
      title: 'Empty passwords are accepted',
      detail: 'Set `PermitEmptyPasswords no` immediately.',
      evidence: 'PermitEmptyPasswords yes',
    });
  }

  if (port === '22') {
    findings.push({
      id: 'ssh-port-22', severity: 'info', category: 'SSH',
      title: 'SSH listening on default port 22',
      detail: 'A non-standard port reduces automated-scanner noise (defence-in-depth, not real security). Skip if you rely on fail2ban / port knocking.',
    });
  } else {
    findings.push({
      id: 'ssh-port-custom', severity: 'ok', category: 'SSH',
      title: `SSH on non-standard port ${port}`,
    });
  }

  if (x11 === 'yes') {
    findings.push({
      id: 'ssh-x11', severity: 'info', category: 'SSH',
      title: 'X11Forwarding is enabled',
      detail: 'X11 forwarding is rarely needed on a server. Disable if you don\'t use it (`X11Forwarding no`).',
    });
  }

  return findings;
}

// ---------- Firewall ----------
//
// Probe the common firewall front-ends in order: ufw, firewalld,
// nftables, then raw iptables. Stop at the first one with active rules.
// A host with no firewall and many public ports is the worst case.

async function auditFirewall() {
  // ufw — most common on Ubuntu/Debian
  const ufw = await run('ufw', ['status'], { timeout: 1500 });
  if (ufw.ok && ufw.stdout) {
    if (/Status:\s*active/i.test(ufw.stdout)) {
      const ruleCount = ufw.stdout.split('\n').filter((l) => /^\S+\s+(ALLOW|DENY|REJECT|LIMIT)/i.test(l)).length;
      return [{
        id: 'fw-ufw-active', severity: 'ok', category: 'Firewall',
        title: `UFW firewall is active${ruleCount ? ` (${ruleCount} rule${ruleCount === 1 ? '' : 's'})` : ''}`,
        evidence: ufw.stdout.split('\n')[0],
      }];
    }
    if (/Status:\s*inactive/i.test(ufw.stdout)) {
      return [{
        id: 'fw-ufw-inactive', severity: 'crit', category: 'Firewall',
        title: 'UFW is installed but inactive',
        detail: 'Run `sudo ufw enable` to activate firewall rules. Make sure to first allow your SSH port (`sudo ufw allow 22/tcp`) so you don\'t lock yourself out.',
      }];
    }
  }

  // firewalld — common on RHEL/CentOS/Fedora
  const fwd = await run('firewall-cmd', ['--state'], { timeout: 1500 });
  if (fwd.ok && /running/i.test(fwd.stdout)) {
    return [{
      id: 'fw-firewalld-active', severity: 'ok', category: 'Firewall',
      title: 'firewalld is active',
    }];
  }

  // nftables
  const nft = await run('nft', ['list', 'ruleset'], { timeout: 1500 });
  if (nft.ok && nft.stdout && nft.stdout.trim().length > 0) {
    const tables = (nft.stdout.match(/^table\s+/gm) || []).length;
    return [{
      id: 'fw-nft-active', severity: 'ok', category: 'Firewall',
      title: `nftables has rules loaded (${tables} table${tables === 1 ? '' : 's'})`,
    }];
  }

  // iptables (legacy)
  const ipt = await run('iptables', ['-S'], { timeout: 1500 });
  if (ipt.ok) {
    const rules = ipt.stdout.split('\n').filter((l) => l.startsWith('-A')).length;
    // A bare iptables install always has the three default chains (INPUT,
    // FORWARD, OUTPUT) declared but no `-A` rules. Anything > 0 is real.
    if (rules > 0) {
      return [{
        id: 'fw-iptables-active', severity: 'ok', category: 'Firewall',
        title: `iptables rules loaded (${rules})`,
      }];
    }
  }

  return [{
    id: 'fw-none', severity: 'crit', category: 'Firewall',
    title: 'No active firewall detected',
    detail: 'No ufw / firewalld / nftables / iptables rules found. Every listening port is reachable from anywhere unless the service itself binds to 127.0.0.1.',
  }];
}

// ---------- Updates ----------
//
// `apt list --upgradable` on Debian/Ubuntu; future: yum/dnf for RHEL.
// Best-effort: a stale `apt update` cache will under-report updates,
// but running `apt update` from the dashboard would be intrusive.

async function auditUpdates() {
  const apt = await run('apt', ['list', '--upgradable'], { timeout: 8000 });
  if (apt.ok) {
    const lines = apt.stdout.split('\n').filter((l) => l && !/^Listing/i.test(l));
    const security = lines.filter((l) => /-security|\bsecurity\b/i.test(l));
    if (lines.length === 0) {
      return [{ id: 'updates-clean', severity: 'ok', category: 'Updates',
        title: 'No package updates available' }];
    }
    return [{
      id: 'updates-available',
      severity: security.length > 0 ? 'warn' : 'info',
      category: 'Updates',
      title: `${lines.length} package update(s) available${security.length > 0 ? ` (${security.length} security)` : ''}`,
      detail: 'Run `sudo apt update && sudo apt upgrade` to apply. Consider enabling `unattended-upgrades` for security patches.',
      evidence: lines.slice(0, 6).map((l) => l.split('/')[0]).join(', ') + (lines.length > 6 ? `, +${lines.length - 6} more` : ''),
    }];
  }
  // dnf / yum (best-effort)
  const dnf = await run('dnf', ['check-update', '-q'], { timeout: 8000 });
  // dnf exits 100 when updates are available — that's normal, not an error.
  const dnfStdout = dnf.stdout || '';
  if (dnfStdout) {
    const lines = dnfStdout.split('\n').filter((l) => l && /^\S+\s+\S+\s+\S/.test(l));
    if (lines.length > 0) {
      return [{
        id: 'updates-dnf-available', severity: 'info', category: 'Updates',
        title: `${lines.length} package update(s) available (dnf)`,
        detail: 'Run `sudo dnf upgrade` to apply.',
      }];
    }
  }
  return [{ id: 'updates-unknown', severity: 'info', category: 'Updates',
    title: 'Could not check for updates', detail: 'No supported package manager found (apt/dnf).' }];
}

// ---------- Authentication ----------
//
// Active sessions (`who`) + recent failed logins (`lastb`). lastb reads
// /var/log/btmp which is typically root-readable; we degrade gracefully
// when not available.

async function auditAuth() {
  const findings = [];

  const who = await run('who', [], { timeout: 1500 });
  if (who.ok) {
    const sessions = who.stdout.split('\n').filter(Boolean);
    if (sessions.length > 0) {
      findings.push({
        id: 'sessions-active', severity: 'info', category: 'Authentication',
        title: `${sessions.length} active login session(s)`,
        evidence: sessions.slice(0, 6).join('\n') + (sessions.length > 6 ? `\n+${sessions.length - 6} more` : ''),
      });
    } else {
      findings.push({
        id: 'sessions-none', severity: 'ok', category: 'Authentication',
        title: 'No active login sessions',
      });
    }
  }

  // lastb — failed login attempts since /var/log/btmp last rotated.
  // We sample at most 200 entries and aggregate by source IP.
  const lastb = await run('lastb', ['-n', '200'], { timeout: 2500 });
  if (lastb.ok && lastb.stdout) {
    const lines = lastb.stdout.split('\n').filter((l) => l.trim() && !/^btmp\b/.test(l));
    if (lines.length > 0) {
      // lastb format: "user tty source date..." — source is in column 2 or 3.
      const ipCounts = new Map();
      const userCounts = new Map();
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts[0]) userCounts.set(parts[0], (userCounts.get(parts[0]) || 0) + 1);
        // Find the first part that looks like an IP or hostname (not tty / pts).
        for (const p of parts.slice(1)) {
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(p) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(p)) {
            ipCounts.set(p, (ipCounts.get(p) || 0) + 1);
            break;
          }
        }
      }
      const topIps = [...ipCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const topUsers = [...userCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      findings.push({
        id: 'auth-failed',
        severity: lines.length > 50 ? 'warn' : 'info',
        category: 'Authentication',
        title: `${lines.length} recent failed login attempts`,
        detail: lines.length > 50
          ? 'High failed-login rate — consider installing fail2ban to auto-ban repeat offenders, and disabling password auth in /etc/ssh/sshd_config.'
          : 'Some failed logins are normal background internet noise. Worth keeping fail2ban or similar installed.',
        evidence: [
          topIps.length ? 'Top sources: ' + topIps.map(([ip, n]) => `${ip} × ${n}`).join(', ') : null,
          topUsers.length ? 'Top targeted users: ' + topUsers.map(([u, n]) => `${u} × ${n}`).join(', ') : null,
        ].filter(Boolean).join('\n'),
      });
    }
  }

  // fail2ban presence
  const f2b = await run('fail2ban-client', ['status'], { timeout: 1500 });
  if (f2b.ok && /Number of jails/i.test(f2b.stdout)) {
    const jails = (f2b.stdout.match(/Number of jails:\s*(\d+)/i) || [])[1];
    findings.push({
      id: 'fail2ban-active', severity: 'ok', category: 'Authentication',
      title: `fail2ban is running${jails ? ` with ${jails} jail(s)` : ''}`,
    });
  }

  return findings;
}

// ---------- Orchestration ----------

async function runAudit({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < AUDIT_CACHE_TTL_MS) {
    return cache;
  }
  const startedAt = Date.now();
  const groups = await Promise.all([
    auditPorts().catch((e) => { logger.warn(`audit ports: ${e.message}`); return []; }),
    auditSsh().catch((e) => { logger.warn(`audit ssh: ${e.message}`); return []; }),
    auditFirewall().catch((e) => { logger.warn(`audit firewall: ${e.message}`); return []; }),
    auditUpdates().catch((e) => { logger.warn(`audit updates: ${e.message}`); return []; }),
    auditAuth().catch((e) => { logger.warn(`audit auth: ${e.message}`); return []; }),
  ]);
  const findings = groups.flat().sort((a, b) =>
    (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
  );
  const summary = {
    crit: findings.filter((f) => f.severity === 'crit').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
    ok:   findings.filter((f) => f.severity === 'ok').length,
    total: findings.length,
  };
  cache = {
    ranAt: now,
    durationMs: Date.now() - startedAt,
    summary,
    findings,
    categories: [...new Set(findings.map((f) => f.category))],
  };
  cacheAt = now;
  return cache;
}

module.exports = { runAudit };
