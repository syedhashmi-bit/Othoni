'use strict';

// Security audit. Read-only checks across the VPS surface:
// network ports, SSH configuration, firewall presence, OS package
// updates, authentication state, filesystem permissions, SUID binaries,
// TLS cert expiry, sudoers, Docker socket, and unattended-upgrades.
//
// Each check is isolated — a failure in one (e.g. ufw not installed)
// doesn't break the others. All checks read state from /proc or run
// common binaries with short timeouts; nothing here writes, sends
// network traffic, or otherwise modifies the system. Remediation is
// handled separately by the actions framework (`security.remediate`)
// so this module stays read-only.
//
// v0.58 additions:
//   - Run history persisted in `audit_runs` + `audit_findings` tables
//   - Diff against the previous run (added / fixed / escalated)
//   - Acknowledge / suppress store in data/audit-acks.json with TTL
//   - Auto-tick on a 10-min schedule so diffs accumulate without user
//     interaction; new crit findings dispatch through the webhook
//     dispatcher in the same fire-and-forget pattern as alerts.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { run } = require('./collectors/exec');
const { getConnections } = require('./collectors/connections');
const history = require('./history');
const logger = require('./logger');

const AUDIT_CACHE_TTL_MS = 60_000;
const AUTO_RUN_INTERVAL_MS = 10 * 60_000;
const ACK_DEFAULT_TTL_MS = 30 * 24 * 3600_000; // 30 days
const ACK_MAX_TTL_MS = 365 * 24 * 3600_000;
const ACKS_PATH = process.env.OTHONI_AUDIT_ACKS_PATH ||
  path.join(__dirname, '..', 'data', 'audit-acks.json');

// Severity ordering for the summary. The page sorts findings worst-first.
const SEV_RANK = { crit: 0, warn: 1, info: 2, ok: 3 };
const SEV_NUM  = { ok: 0, info: 1, warn: 2, crit: 3 };

let cache = null;
let cacheAt = 0;
let acksCache = null;
let dispatcher = null;     // injected at startup — same shape as alerts/checks
let autoTimer = null;
let schemaReady = false;

// ---------- Ports ----------
//
// We already enumerate listening sockets in collectors/connections.js,
// which reads /proc/net/{tcp,tcp6,udp,udp6}. Re-use that here instead
// of shelling out to ss/lsof — same data, lower overhead.

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

function parseSshConfig(text) {
  const directives = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^match\s+/i.test(line)) break;
    const m = line.match(/^(\S+)\s+(.+?)$/);
    if (!m) continue;
    const [, key, val] = m;
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

  if (permitRoot === 'yes') {
    findings.push({
      id: 'ssh-root-yes', severity: 'crit', category: 'SSH',
      title: 'Root SSH login is enabled with full access',
      detail: 'Set `PermitRootLogin no` (or at minimum `prohibit-password`) and use a regular user with sudo.',
      evidence: `PermitRootLogin ${d['permitrootlogin']}`,
      remediation: { kind: 'security.remediate', target: 'ssh.disable-root-login' },
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
      remediation: { kind: 'security.remediate', target: 'ssh.disable-password-auth' },
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
      remediation: { kind: 'security.remediate', target: 'ssh.disable-empty-passwords' },
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

async function auditFirewall() {
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

  const fwd = await run('firewall-cmd', ['--state'], { timeout: 1500 });
  if (fwd.ok && /running/i.test(fwd.stdout)) {
    return [{
      id: 'fw-firewalld-active', severity: 'ok', category: 'Firewall',
      title: 'firewalld is active',
    }];
  }

  const nft = await run('nft', ['list', 'ruleset'], { timeout: 1500 });
  if (nft.ok && nft.stdout && nft.stdout.trim().length > 0) {
    const tables = (nft.stdout.match(/^table\s+/gm) || []).length;
    return [{
      id: 'fw-nft-active', severity: 'ok', category: 'Firewall',
      title: `nftables has rules loaded (${tables} table${tables === 1 ? '' : 's'})`,
    }];
  }

  const ipt = await run('iptables', ['-S'], { timeout: 1500 });
  if (ipt.ok) {
    const rules = ipt.stdout.split('\n').filter((l) => l.startsWith('-A')).length;
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
  const dnf = await run('dnf', ['check-update', '-q'], { timeout: 8000 });
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

  const lastb = await run('lastb', ['-n', '200'], { timeout: 2500 });
  if (lastb.ok && lastb.stdout) {
    const lines = lastb.stdout.split('\n').filter((l) => l.trim() && !/^btmp\b/.test(l));
    if (lines.length > 0) {
      const ipCounts = new Map();
      const userCounts = new Map();
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts[0]) userCounts.set(parts[0], (userCounts.get(parts[0]) || 0) + 1);
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

// ---------- Filesystem (world-writable dirs under /etc, /var/www) ----------
//
// World-writable directories outside /tmp/-style paths are usually a
// misconfigured umask or a service install going wrong. We scan two
// roots and surface anything with the world-write bit set (0002) that
// is not sticky-bit-protected.

async function auditFilesystem() {
  const findings = [];
  const roots = ['/etc', '/var/www'];
  const offenders = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // -xdev: don't cross filesystem boundaries
    // -type d: directories only
    // -perm -0002: any entry with world-write
    // ! -perm -1000: exclude sticky-bit dirs (legitimate shared scratch)
    const r = await run('find', [root, '-xdev', '-type', 'd', '-perm', '-0002', '!', '-perm', '-1000', '-print'], { timeout: 5000 });
    if (r.ok && r.stdout) {
      const lines = r.stdout.split('\n').filter(Boolean);
      for (const l of lines) offenders.push(l);
    }
  }
  if (offenders.length > 0) {
    findings.push({
      id: 'fs-world-writable',
      severity: 'warn',
      category: 'Filesystem',
      title: `${offenders.length} world-writable director${offenders.length === 1 ? 'y' : 'ies'} under /etc or /var/www`,
      detail: 'A non-sticky world-writable directory in a system path lets any local user drop files that root may later execute or read. `chmod o-w <dir>` is usually safe.',
      evidence: offenders.slice(0, 10).join('\n') + (offenders.length > 10 ? `\n+${offenders.length - 10} more` : ''),
    });
  } else {
    findings.push({
      id: 'fs-world-writable-clean',
      severity: 'ok',
      category: 'Filesystem',
      title: 'No world-writable dirs under /etc or /var/www',
    });
  }
  return findings;
}

// ---------- SUID baseline ----------
//
// SUID binaries run with the file owner's privileges. The distro ships
// a known set (sudo, passwd, mount, ...). Anything outside that
// baseline is worth a look — could be a legitimate package or a
// privilege-escalation vector. We compare against a conservative
// allow-list of common Debian/Ubuntu baseline SUID binaries.

const SUID_BASELINE = new Set([
  '/usr/bin/su',
  '/usr/bin/sudo',
  '/usr/bin/passwd',
  '/usr/bin/chsh',
  '/usr/bin/chfn',
  '/usr/bin/newgrp',
  '/usr/bin/gpasswd',
  '/usr/bin/mount',
  '/usr/bin/umount',
  '/usr/bin/pkexec',
  '/usr/bin/fusermount',
  '/usr/bin/fusermount3',
  '/usr/bin/expiry',
  '/usr/lib/openssh/ssh-keysign',
  '/usr/lib/dbus-1.0/dbus-daemon-launch-helper',
  '/usr/lib/policykit-1/polkit-agent-helper-1',
  '/usr/lib/snapd/snap-confine',
  '/usr/sbin/pppd',
  '/usr/sbin/unix_chkpwd',
  '/usr/sbin/mount.nfs',
  '/usr/sbin/exim4',
  '/usr/bin/at',
  '/usr/bin/crontab',
  '/usr/bin/wall',
  '/usr/bin/write',
  '/usr/bin/screen',
  '/usr/libexec/polkit-agent-helper-1',
  '/usr/libexec/dbus-1/dbus-daemon-launch-helper',
]);

async function auditSuid() {
  const findings = [];
  // Scan common system paths; skip user-level mounts to keep this quick.
  const r = await run('find', ['/usr', '/bin', '/sbin', '-xdev', '-type', 'f', '-perm', '-4000', '-print'], { timeout: 10_000 });
  if (!r.ok) {
    return [{ id: 'suid-skip', severity: 'info', category: 'Filesystem',
      title: 'Could not enumerate SUID binaries', detail: r.stderr || r.code || 'find failed' }];
  }
  const found = r.stdout.split('\n').filter(Boolean);
  const unexpected = found.filter((p) => !SUID_BASELINE.has(p));
  if (unexpected.length > 0) {
    findings.push({
      id: 'suid-unexpected',
      severity: 'warn',
      category: 'Filesystem',
      title: `${unexpected.length} SUID binar${unexpected.length === 1 ? 'y' : 'ies'} outside the baseline`,
      detail: 'These have the SUID bit set and aren\'t on the conservative Debian/Ubuntu baseline. Most are legitimate (installed by a package), but verify each — a rogue SUID binary is a common rootkit persistence trick.',
      evidence: unexpected.slice(0, 10).join('\n') + (unexpected.length > 10 ? `\n+${unexpected.length - 10} more` : ''),
    });
  } else {
    findings.push({
      id: 'suid-clean',
      severity: 'ok',
      category: 'Filesystem',
      title: `${found.length} SUID binaries, all within baseline`,
    });
  }
  return findings;
}

// ---------- TLS cert expiry ----------
//
// Walk /etc/letsencrypt/live and /etc/ssl/certs for PEM-encoded leaf
// certs; parse the notAfter from the first valid one in each dir.
// A cert that has expired or expires within 14 days is a finding.

const EXPIRY_WARN_DAYS = 30;
const EXPIRY_CRIT_DAYS = 7;

function parsePemCertNotAfter(pemText) {
  try {
    const m = pemText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (!m) return null;
    const cert = new (require('crypto').X509Certificate)(m[0]);
    return { validTo: cert.validTo, subject: cert.subject, issuer: cert.issuer };
  } catch (_e) {
    return null;
  }
}

function walkPems(root, max = 50) {
  const out = [];
  let stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && /\.(pem|crt|cer)$/i.test(ent.name)) out.push(p);
    }
  }
  return out;
}

async function auditTls() {
  const findings = [];
  const roots = ['/etc/letsencrypt/live', '/etc/ssl/certs'];
  const seen = new Set();          // dedup by issuer+subject+notAfter
  const checked = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // letsencrypt's `live` directory has one subdir per cert with a
    // symlink to fullchain.pem; pick those preferentially.
    if (root === '/etc/letsencrypt/live') {
      let dirs;
      try { dirs = fs.readdirSync(root, { withFileTypes: true }); }
      catch { dirs = []; }
      for (const ent of dirs) {
        if (!ent.isDirectory()) continue;
        const candidate = path.join(root, ent.name, 'fullchain.pem');
        if (fs.existsSync(candidate)) {
          let text;
          try { text = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
          const info = parsePemCertNotAfter(text);
          if (info) checked.push({ path: candidate, ...info });
        }
      }
    } else {
      // /etc/ssl/certs is huge and full of CA certs we don't operate.
      // Skip CA bundle and only flag local certs (rare); keep this lean
      // by only checking up to 8 files.
      const pems = walkPems(root, 8);
      for (const p of pems) {
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        const info = parsePemCertNotAfter(text);
        if (info && info.subject && !/^O\s*=\s*(GlobalSign|DigiCert|Let's Encrypt)\b/i.test(info.subject)) {
          // Skip CA-style subjects; we only want operator-managed certs.
          // Conservative: include only if subject has a CN.
          if (!/CN\s*=/i.test(info.subject)) continue;
          checked.push({ path: p, ...info });
        }
      }
    }
  }

  if (checked.length === 0) {
    findings.push({
      id: 'tls-none',
      severity: 'info',
      category: 'TLS',
      title: 'No managed TLS certificates found',
      detail: 'Looked under /etc/letsencrypt/live and /etc/ssl/certs. Skip if this host doesn\'t terminate HTTPS locally.',
    });
    return findings;
  }

  const now = Date.now();
  for (const c of checked) {
    const dedupKey = `${c.subject}|${c.issuer}|${c.validTo}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const expiresAt = Date.parse(c.validTo);
    const daysLeft = Math.round((expiresAt - now) / (24 * 3600_000));
    const cn = (c.subject.match(/CN\s*=\s*([^,\n]+)/) || [])[1] || c.path;
    if (!Number.isFinite(expiresAt)) {
      findings.push({
        id: `tls-bad-${cn}`,
        severity: 'info',
        category: 'TLS',
        title: `Could not parse cert expiry for ${cn}`,
        evidence: c.path,
      });
    } else if (daysLeft < 0) {
      findings.push({
        id: `tls-expired-${cn}`,
        severity: 'crit',
        category: 'TLS',
        title: `Certificate for ${cn} has expired`,
        detail: `Expired ${-daysLeft} day(s) ago. Renew immediately with certbot or your provider.`,
        evidence: `${c.path}\n${c.validTo}`,
      });
    } else if (daysLeft <= EXPIRY_CRIT_DAYS) {
      findings.push({
        id: `tls-expiring-crit-${cn}`,
        severity: 'crit',
        category: 'TLS',
        title: `Certificate for ${cn} expires in ${daysLeft} day(s)`,
        detail: 'Renew now. Letsencrypt: `sudo certbot renew`.',
        evidence: `${c.path}\n${c.validTo}`,
      });
    } else if (daysLeft <= EXPIRY_WARN_DAYS) {
      findings.push({
        id: `tls-expiring-warn-${cn}`,
        severity: 'warn',
        category: 'TLS',
        title: `Certificate for ${cn} expires in ${daysLeft} day(s)`,
        evidence: `${c.path}\n${c.validTo}`,
      });
    } else {
      findings.push({
        id: `tls-ok-${cn}`,
        severity: 'ok',
        category: 'TLS',
        title: `Certificate for ${cn} valid for ${daysLeft} more day(s)`,
      });
    }
  }
  return findings;
}

// ---------- sudoers NOPASSWD ----------
//
// `sudo -l` requires real auth; instead read /etc/sudoers and the
// /etc/sudoers.d directory directly (othoni runs as root so this is
// readable). Flag any entry with the NOPASSWD tag — passwordless sudo
// is a frequent misconfiguration that turns any compromised account
// into root.

function readSudoersFiles() {
  const out = [];
  try {
    const main = fs.readFileSync('/etc/sudoers', 'utf8');
    out.push({ file: '/etc/sudoers', text: main });
  } catch { /* ignore */ }
  let dirEntries = [];
  try { dirEntries = fs.readdirSync('/etc/sudoers.d', { withFileTypes: true }); }
  catch { /* dir may not exist */ }
  for (const ent of dirEntries) {
    if (!ent.isFile()) continue;
    if (/\.(bak|dpkg-old|dpkg-dist)$/.test(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;
    const p = path.join('/etc/sudoers.d', ent.name);
    try { out.push({ file: p, text: fs.readFileSync(p, 'utf8') }); }
    catch { /* skip */ }
  }
  return out;
}

async function auditSudoers() {
  const findings = [];
  const files = readSudoersFiles();
  if (files.length === 0) {
    return [{ id: 'sudoers-unreadable', severity: 'info', category: 'Sudoers',
      title: 'sudoers config unreadable', detail: 'othoni cannot read /etc/sudoers (not running as root?). Skipping check.' }];
  }
  const nopasswd = [];
  for (const { file, text } of files) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('Defaults')) continue;
      if (/\bNOPASSWD\s*:/i.test(line)) nopasswd.push({ file, line });
    }
  }
  if (nopasswd.length > 0) {
    const sevDist = nopasswd.some((e) => /\bALL\b/.test(e.line)) ? 'crit' : 'warn';
    findings.push({
      id: 'sudoers-nopasswd',
      severity: sevDist,
      category: 'Sudoers',
      title: `${nopasswd.length} NOPASSWD entry/entries in sudoers`,
      detail: 'Passwordless sudo means a compromised account can immediately escalate. Limit NOPASSWD to specific commands; require a password for ALL.',
      evidence: nopasswd.slice(0, 6).map((e) => `${e.file}: ${e.line}`).join('\n') + (nopasswd.length > 6 ? `\n+${nopasswd.length - 6} more` : ''),
    });
  } else {
    findings.push({
      id: 'sudoers-clean',
      severity: 'ok',
      category: 'Sudoers',
      title: 'No NOPASSWD entries in sudoers',
    });
  }
  return findings;
}

// ---------- Docker socket / daemon permissions ----------
//
// /var/run/docker.sock effectively grants root if a user can write to
// it. We flag world-writability or group-writability beyond `docker`.

async function auditDocker() {
  const findings = [];
  const sock = '/var/run/docker.sock';
  if (!fs.existsSync(sock)) {
    return [{ id: 'docker-not-installed', severity: 'ok', category: 'Docker',
      title: 'Docker socket not present (Docker not installed)' }];
  }
  let stat;
  try { stat = fs.statSync(sock); }
  catch (e) {
    return [{ id: 'docker-unreadable', severity: 'info', category: 'Docker',
      title: 'Could not stat /var/run/docker.sock', detail: e.message }];
  }
  const mode = stat.mode & 0o777;
  const worldWrite = (mode & 0o002) !== 0;
  const groupWrite = (mode & 0o020) !== 0;

  if (worldWrite) {
    findings.push({
      id: 'docker-sock-world-writable',
      severity: 'crit',
      category: 'Docker',
      title: 'Docker socket is world-writable',
      detail: 'Any local user can launch privileged containers and escape to root. `chmod o-w /var/run/docker.sock` immediately, then audit Docker group membership.',
      evidence: `mode = ${mode.toString(8).padStart(4, '0')}`,
    });
  } else if (groupWrite) {
    // Check who's in the docker group.
    let dockerGroup = null;
    try {
      const groups = fs.readFileSync('/etc/group', 'utf8');
      const m = groups.match(/^docker:.*:\d+:(.*)$/m);
      if (m) dockerGroup = m[1].split(',').filter(Boolean);
    } catch { /* ignore */ }
    if (dockerGroup && dockerGroup.length > 0) {
      findings.push({
        id: 'docker-group-members',
        severity: 'info',
        category: 'Docker',
        title: `${dockerGroup.length} user(s) in the docker group`,
        detail: 'Docker group membership is effectively root. Make sure every listed user genuinely needs it.',
        evidence: `docker: ${dockerGroup.join(', ')}`,
      });
    } else {
      findings.push({
        id: 'docker-sock-ok',
        severity: 'ok',
        category: 'Docker',
        title: 'Docker socket permissions look correct',
        evidence: `mode = ${mode.toString(8).padStart(4, '0')}`,
      });
    }
  } else {
    findings.push({
      id: 'docker-sock-ok',
      severity: 'ok',
      category: 'Docker',
      title: 'Docker socket permissions look correct',
      evidence: `mode = ${mode.toString(8).padStart(4, '0')}`,
    });
  }
  return findings;
}

// ---------- Unattended-upgrades ----------
//
// On Debian/Ubuntu, `unattended-upgrades` is the standard auto-patcher.
// Off-by-default on minimal installs. We check that the package is
// installed and that the Update-Package-Lists + Unattended-Upgrade
// keys are non-zero in 20auto-upgrades (the standard knobs).

async function auditAutoUpgrades() {
  const findings = [];
  const conf = '/etc/apt/apt.conf.d/20auto-upgrades';
  if (!fs.existsSync(conf)) {
    // Probably non-Debian, or never enabled. Skip if apt isn't here.
    if (!fs.existsSync('/etc/debian_version')) {
      return [{ id: 'autoupgrades-na', severity: 'ok', category: 'Updates',
        title: 'Unattended-upgrades not applicable (non-Debian)' }];
    }
    findings.push({
      id: 'autoupgrades-missing',
      severity: 'warn',
      category: 'Updates',
      title: 'unattended-upgrades is not configured',
      detail: 'Install with `sudo apt install unattended-upgrades` and run `sudo dpkg-reconfigure --priority=low unattended-upgrades`. Auto-applies security patches without manual intervention.',
    });
    return findings;
  }
  let text;
  try { text = fs.readFileSync(conf, 'utf8'); }
  catch {
    return [{ id: 'autoupgrades-unreadable', severity: 'info', category: 'Updates',
      title: 'Could not read /etc/apt/apt.conf.d/20auto-upgrades' }];
  }
  const upd = (text.match(/APT::Periodic::Update-Package-Lists\s+"(\d+)"/) || [])[1];
  const unatt = (text.match(/APT::Periodic::Unattended-Upgrade\s+"(\d+)"/) || [])[1];
  if (parseInt(upd || '0', 10) >= 1 && parseInt(unatt || '0', 10) >= 1) {
    findings.push({
      id: 'autoupgrades-on',
      severity: 'ok',
      category: 'Updates',
      title: 'unattended-upgrades is enabled',
      evidence: `Update-Package-Lists "${upd}"; Unattended-Upgrade "${unatt}"`,
    });
  } else {
    findings.push({
      id: 'autoupgrades-off',
      severity: 'warn',
      category: 'Updates',
      title: 'unattended-upgrades is installed but disabled',
      detail: 'Set both `Update-Package-Lists` and `Unattended-Upgrade` to "1" in 20auto-upgrades.',
      evidence: `Update-Package-Lists "${upd || '?'}"; Unattended-Upgrade "${unatt || '?'}"`,
    });
  }
  return findings;
}

// ---------- Persistence (audit_runs + audit_findings) ----------

function ensureSchema() {
  if (schemaReady) return;
  const db = history.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_runs (
      t            INTEGER NOT NULL,
      duration_ms  INTEGER,
      total        INTEGER NOT NULL,
      crit         INTEGER NOT NULL,
      warn         INTEGER NOT NULL,
      info         INTEGER NOT NULL,
      ok           INTEGER NOT NULL,
      added        INTEGER NOT NULL DEFAULT 0,
      fixed        INTEGER NOT NULL DEFAULT 0,
      escalated    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_audit_runs_t ON audit_runs(t);

    CREATE TABLE IF NOT EXISTS audit_findings (
      t          INTEGER NOT NULL,
      finding_id TEXT    NOT NULL,
      category   TEXT,
      severity   TEXT,
      title      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_findings_t        ON audit_findings(t);
    CREATE INDEX IF NOT EXISTS idx_audit_findings_finding_t ON audit_findings(finding_id, t);
  `);
  schemaReady = true;
}

function recordRun(now, durationMs, summary, findings, diff) {
  ensureSchema();
  const db = history.getDb();
  const ins = db.prepare(
    `INSERT INTO audit_runs (t, duration_ms, total, crit, warn, info, ok, added, fixed, escalated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const finsStmt = db.prepare(
    `INSERT INTO audit_findings (t, finding_id, category, severity, title) VALUES (?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    ins.run(
      now, durationMs,
      summary.total, summary.crit, summary.warn, summary.info, summary.ok,
      diff.added.length, diff.fixed.length, diff.escalated.length
    );
    // Persist only non-ok findings — "ok" rows would balloon the table
    // and we don't diff against them.
    for (const f of findings) {
      if (f.severity === 'ok') continue;
      finsStmt.run(now, f.id, f.category || null, f.severity, f.title || '');
    }
  });
  tx();
}

function loadPreviousRun() {
  ensureSchema();
  const db = history.getDb();
  const runRow = db.prepare('SELECT t FROM audit_runs ORDER BY t DESC LIMIT 1').get();
  if (!runRow) return null;
  const rows = db.prepare(
    'SELECT finding_id AS id, category, severity, title FROM audit_findings WHERE t = ?'
  ).all(runRow.t);
  return { t: runRow.t, findings: rows };
}

function listHistory({ range = '7d' } = {}) {
  ensureSchema();
  const SPAN = {
    '24h': 24 * 3600_000,
    '7d':  7 * 24 * 3600_000,
    '30d': 30 * 24 * 3600_000,
  };
  const span = SPAN[range] || SPAN['7d'];
  const from = Date.now() - span;
  const rows = history.getDb()
    .prepare(
      `SELECT t, duration_ms AS durationMs, total, crit, warn, info, ok, added, fixed, escalated
         FROM audit_runs
        WHERE t >= ?
        ORDER BY t ASC`
    )
    .all(from);
  return { range, from, to: Date.now(), runs: rows };
}

// ---------- Acks ----------

function readAcks() {
  if (acksCache) return acksCache;
  try {
    const raw = fs.readFileSync(ACKS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    acksCache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`audit-acks: read failed (${e.message}); starting fresh`);
    acksCache = {};
  }
  return acksCache;
}

function persistAcks() {
  const dir = path.dirname(ACKS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${ACKS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(acksCache, null, 2));
  fs.renameSync(tmp, ACKS_PATH);
}

function pruneExpiredAcks() {
  const acks = readAcks();
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(acks)) {
    if (acks[id].expiresAt && acks[id].expiresAt < now) {
      delete acks[id];
      changed = true;
    }
  }
  if (changed) persistAcks();
}

function isAcked(findingId, now = Date.now()) {
  const acks = readAcks();
  const a = acks[findingId];
  if (!a) return false;
  if (a.expiresAt && a.expiresAt < now) return false;
  return true;
}

function listAcks() {
  pruneExpiredAcks();
  return readAcks();
}

function ackFinding({ id, reason = '', actor = null, ttlMs = ACK_DEFAULT_TTL_MS }) {
  if (typeof id !== 'string' || !id) throw Object.assign(new Error('id required'), { code: 'invalid_request' });
  const safeTtl = Math.max(60_000, Math.min(ACK_MAX_TTL_MS, ttlMs || ACK_DEFAULT_TTL_MS));
  const acks = readAcks();
  acks[id] = {
    reason: String(reason || '').slice(0, 280),
    actor: actor || null,
    ackedAt: Date.now(),
    expiresAt: Date.now() + safeTtl,
  };
  acksCache = acks;
  persistAcks();
  cache = null; // force the next audit() to re-annotate ack state
  return acks[id];
}

function unackFinding(id) {
  const acks = readAcks();
  if (!(id in acks)) return false;
  delete acks[id];
  acksCache = acks;
  persistAcks();
  cache = null;
  return true;
}

// ---------- Diff against the previous run ----------

function diffAgainstPrev(currFindings, prev) {
  const curr = currFindings.filter((f) => f.severity !== 'ok');
  const currMap = new Map(curr.map((f) => [f.id, f]));
  const prevMap = new Map((prev?.findings || []).map((f) => [f.id, f]));

  const added = [];
  const escalated = [];
  for (const [id, f] of currMap) {
    const p = prevMap.get(id);
    if (!p) {
      added.push({ id, severity: f.severity, title: f.title, category: f.category });
    } else if (SEV_NUM[f.severity] > SEV_NUM[p.severity]) {
      escalated.push({
        id, title: f.title, category: f.category,
        from: p.severity, to: f.severity,
      });
    }
  }
  const fixed = [];
  for (const [id, p] of prevMap) {
    if (!currMap.has(id)) {
      fixed.push({ id, severity: p.severity, title: p.title, category: p.category });
    }
  }
  return { added, fixed, escalated };
}

// ---------- Dispatcher (findings → alerts → webhooks) ----------

function setDispatcher(fn) { dispatcher = fn; }

// Build a webhook-compatible "fire event" so existing destinations
// (slack/discord/generic) render reasonable text without needing a new
// payload shape on the consumer side.
function dispatchSecurityEvent(f) {
  if (typeof dispatcher !== 'function') return;
  try {
    dispatcher({
      rule: {
        id: `audit:${f.id}`,
        label: `Security audit · ${f.title}`,
        metric: 'security',
        comparator: 'gt',
        threshold: 0,
        severity: f.severity,
        host: null,
      },
      value: 1,
      valueFmt: f.severity.toUpperCase(),
      thresholdFmt: 'baseline',
      sustainedFor: 0,
    });
  } catch (e) {
    logger.warn(`audit: dispatch threw: ${e.message}`);
  }
}

// ---------- Orchestration ----------

async function runAudit({ force = false, source = 'manual' } = {}) {
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
    auditFilesystem().catch((e) => { logger.warn(`audit fs: ${e.message}`); return []; }),
    auditSuid().catch((e) => { logger.warn(`audit suid: ${e.message}`); return []; }),
    auditTls().catch((e) => { logger.warn(`audit tls: ${e.message}`); return []; }),
    auditSudoers().catch((e) => { logger.warn(`audit sudoers: ${e.message}`); return []; }),
    auditDocker().catch((e) => { logger.warn(`audit docker: ${e.message}`); return []; }),
    auditAutoUpgrades().catch((e) => { logger.warn(`audit auto-upgrades: ${e.message}`); return []; }),
  ]);
  const allFindings = groups.flat();

  // Annotate ack state on each finding. Acked findings keep their
  // severity for display purposes but are excluded from the summary
  // crit/warn counts so an operator can mute known-acceptable ones.
  const acks = readAcks();
  const now2 = Date.now();
  for (const f of allFindings) {
    const a = acks[f.id];
    if (a && (!a.expiresAt || a.expiresAt > now2)) {
      f.acked = true;
      f.ackReason = a.reason || null;
      f.ackExpiresAt = a.expiresAt || null;
    }
  }

  // Sort worst-first, acked findings demoted within their group.
  const findings = allFindings.sort((a, b) => {
    const sevA = (SEV_RANK[a.severity] ?? 9);
    const sevB = (SEV_RANK[b.severity] ?? 9);
    if (sevA !== sevB) return sevA - sevB;
    if (!!a.acked !== !!b.acked) return a.acked ? 1 : -1;
    return 0;
  });

  // Summary — exclude acked findings from severity counts.
  const visible = findings.filter((f) => !f.acked);
  const summary = {
    crit: visible.filter((f) => f.severity === 'crit').length,
    warn: visible.filter((f) => f.severity === 'warn').length,
    info: visible.filter((f) => f.severity === 'info').length,
    ok:   visible.filter((f) => f.severity === 'ok').length,
    acked: findings.filter((f) => f.acked).length,
    total: findings.length,
  };

  // Diff against the previous on-disk run.
  const prev = loadPreviousRun();
  const diff = diffAgainstPrev(findings, prev);

  // Persist + dispatch.
  try { recordRun(now, Date.now() - startedAt, summary, findings, diff); }
  catch (e) { logger.warn(`audit: persist run failed: ${e.message}`); }

  // Dispatch every newly-added CRIT finding (skip acked). We dispatch
  // on diff edges only — no spam when an existing crit persists across
  // runs.
  if (prev) {
    const addedIds = new Set(diff.added.map((d) => d.id));
    const escalatedIds = new Set(diff.escalated.map((d) => d.id));
    for (const f of findings) {
      if (f.acked) continue;
      if (f.severity !== 'crit') continue;
      if (addedIds.has(f.id) || escalatedIds.has(f.id)) {
        dispatchSecurityEvent(f);
      }
    }
  }

  cache = {
    ranAt: now,
    durationMs: Date.now() - startedAt,
    source,
    summary,
    findings,
    categories: [...new Set(findings.map((f) => f.category))],
    diff,
    prevRanAt: prev?.t || null,
  };
  cacheAt = now;
  return cache;
}

// ---------- Background auto-tick ----------

function startAutoRun() {
  ensureSchema();
  if (autoTimer) return;
  // Defer the first tick slightly so startup doesn't fight a fresh
  // history.start() for SQLite.
  setTimeout(() => {
    runAudit({ force: true, source: 'auto' })
      .catch((e) => logger.warn(`audit auto tick failed: ${e.message}`));
  }, 30_000);
  autoTimer = setInterval(() => {
    runAudit({ force: true, source: 'auto' })
      .catch((e) => logger.warn(`audit auto tick failed: ${e.message}`));
  }, AUTO_RUN_INTERVAL_MS);
  logger.info(`audit: auto-run scheduled every ${Math.round(AUTO_RUN_INTERVAL_MS / 60_000)}m`);
}

function stopAutoRun() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

module.exports = {
  runAudit,
  setDispatcher,
  startAutoRun, stopAutoRun,
  ackFinding, unackFinding, listAcks,
  listHistory,
  ensureSchema,
};
