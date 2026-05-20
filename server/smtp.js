'use strict';

// Minimal SMTP client (v0.59). Submission-mode only: STARTTLS on port
// 587, AUTH PLAIN/LOGIN, single MAIL FROM + RCPT TO + DATA. Sized to
// cover the common transactional-email case (Gmail, SendGrid,
// Mailgun, Postfix-on-VPS) without dragging in nodemailer.
//
// Off by default — enable with `OTHONI_SMTP_HOST` in .env. When unset
// the email webhook format returns a clean enabled:false error
// instead of attempting a connection.

const net = require('net');
const tls = require('tls');
const logger = require('./logger');

const CFG = {
  host:   process.env.OTHONI_SMTP_HOST || null,
  port:   parseInt(process.env.OTHONI_SMTP_PORT || '587', 10),
  user:   process.env.OTHONI_SMTP_USER || null,
  pass:   process.env.OTHONI_SMTP_PASS || null,
  from:   process.env.OTHONI_SMTP_FROM || null,
  // 'starttls' (default — port 587, plaintext-then-upgrade) or
  // 'tls' (port 465, encrypted from the first byte).
  secure: (process.env.OTHONI_SMTP_SECURE || '').toLowerCase() === 'true'
       || (process.env.OTHONI_SMTP_SECURE || '').toLowerCase() === 'tls',
  // Allow self-signed certs only when explicitly opted in — submission
  // servers should have valid certs in production.
  rejectUnauthorized: (process.env.OTHONI_SMTP_INSECURE || '').toLowerCase() !== 'true',
  // Socket timeout per stage. Conservative — submission servers
  // usually respond inside a second; this is just there to make sure
  // a broken net path can't stall a webhook delivery indefinitely.
  timeoutMs: 8000,
};

function isEnabled() {
  return !!(CFG.host && CFG.from);
}

function snapshot() {
  return {
    enabled:   isEnabled(),
    host:      CFG.host,
    port:      CFG.port,
    from:      CFG.from,
    authed:    !!(CFG.user && CFG.pass),
    secure:    CFG.secure,
  };
}

// Read CRLF-terminated lines from the socket and emit one SMTP reply
// (which may span multiple lines — a "250-" prefix means continuation,
// "250 " means final). Resolves to { code, lines } when a final line
// arrives or rejects when the socket dies before that.
function readReply(sock) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const lines = [];
    function ondata(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        lines.push(line);
        // Last line has a space after the code; continuations have "-".
        if (line.length >= 4 && line[3] === ' ') {
          sock.off('data', ondata);
          sock.off('error', onerror);
          sock.off('end', onend);
          const code = parseInt(line.slice(0, 3), 10);
          resolve({ code, lines });
          return;
        }
      }
    }
    function onerror(e) { cleanup(); reject(e); }
    function onend()    { cleanup(); reject(new Error('connection closed before reply')); }
    function cleanup() {
      sock.off('data', ondata);
      sock.off('error', onerror);
      sock.off('end', onend);
    }
    sock.on('data', ondata);
    sock.once('error', onerror);
    sock.once('end', onend);
  });
}

function write(sock, line) {
  return new Promise((resolve, reject) => {
    sock.write(line + '\r\n', (err) => (err ? reject(err) : resolve()));
  });
}

async function expect(sock, expected) {
  const reply = await readReply(sock);
  if (Math.floor(reply.code / 100) !== Math.floor(expected / 100)) {
    const msg = `SMTP unexpected reply: expected ${expected}, got ${reply.code} (${reply.lines.join(' | ')})`;
    const e = new Error(msg);
    e.code = reply.code;
    throw e;
  }
  return reply;
}

// Parse a `mailto:foo@bar.com` URL into the bare address.
function parseMailto(s) {
  if (typeof s !== 'string') return null;
  if (s.startsWith('mailto:')) return s.slice(7).split('?')[0].trim();
  if (/^[^\s<>]+@[^\s<>]+\.[^\s<>]+$/.test(s)) return s.trim();
  return null;
}

function buildMessage({ from, to, subject, text }) {
  const date = new Date().toUTCString();
  // RFC-5322ish. We keep body to plain US-ASCII / UTF-8 with no
  // attachments; no need to MIME-multipart. Lines starting with "."
  // get dot-stuffed below before DATA.
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    `X-Mailer: othoni-smtp/1`,
  ];
  return headers.join('\r\n') + '\r\n\r\n' + text;
}

// Per RFC 5321 §4.5.2 — a "." on a line by itself terminates DATA.
// Any line that starts with "." must be doubled.
function dotStuff(body) {
  return body
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? '.' + l : l))
    .join('\r\n');
}

function authPlain(user, pass) {
  // RFC 4616 — \0user\0pass
  return Buffer.from('\0' + user + '\0' + pass, 'utf8').toString('base64');
}

async function sendMail({ to, subject, text, replyTo } = {}) {
  if (!isEnabled()) {
    const e = new Error('SMTP not configured (set OTHONI_SMTP_HOST and OTHONI_SMTP_FROM)');
    e.code = 'smtp_not_configured';
    throw e;
  }
  const addr = parseMailto(to);
  if (!addr) {
    const e = new Error(`invalid recipient: ${to}`);
    e.code = 'invalid_recipient';
    throw e;
  }
  const startedAt = Date.now();

  // Establish the transport. `tls` mode means TLS from the start
  // (port 465 / "smtps"); otherwise plain socket then STARTTLS to
  // upgrade — the standard submission-port flow.
  let sock = CFG.secure
    ? tls.connect({
        host: CFG.host, port: CFG.port, rejectUnauthorized: CFG.rejectUnauthorized,
        servername: CFG.host,
      })
    : net.connect({ host: CFG.host, port: CFG.port });
  sock.setEncoding('utf8');
  sock.setTimeout(CFG.timeoutMs);

  const cleanup = () => { try { sock.end(); } catch { /* ignore */ } };

  try {
    // Wait for the server's 220 greeting.
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('secureConnect', resolve);
      sock.once('timeout', () => reject(new Error('connect timeout')));
      sock.once('error', reject);
    });
    sock.setTimeout(CFG.timeoutMs);
    await expect(sock, 220);

    const ehlo = await sendEhlo(sock);

    // Upgrade with STARTTLS if we're on a plain socket.
    if (!CFG.secure) {
      await write(sock, 'STARTTLS');
      await expect(sock, 220);
      sock = tls.connect({
        socket: sock,
        host: CFG.host,
        servername: CFG.host,
        rejectUnauthorized: CFG.rejectUnauthorized,
      });
      sock.setEncoding('utf8');
      sock.setTimeout(CFG.timeoutMs);
      await new Promise((resolve, reject) => {
        sock.once('secureConnect', resolve);
        sock.once('error', reject);
      });
      // RFC 3207 §5 — repeat EHLO after STARTTLS to pick up the
      // post-encryption capability list.
      await sendEhlo(sock);
    }

    // AUTH. Skip when no credentials are configured (open relay on a
    // private network).
    if (CFG.user && CFG.pass) {
      const supports = (ehlo.lines.join('\n').toUpperCase());
      if (supports.includes('AUTH') && supports.includes('PLAIN')) {
        await write(sock, 'AUTH PLAIN ' + authPlain(CFG.user, CFG.pass));
        await expect(sock, 235);
      } else if (supports.includes('AUTH') && supports.includes('LOGIN')) {
        await write(sock, 'AUTH LOGIN');
        await expect(sock, 334);
        await write(sock, Buffer.from(CFG.user, 'utf8').toString('base64'));
        await expect(sock, 334);
        await write(sock, Buffer.from(CFG.pass, 'utf8').toString('base64'));
        await expect(sock, 235);
      } else {
        // Some servers advertise capabilities only after STARTTLS;
        // fall through and try PLAIN unconditionally rather than
        // give up.
        await write(sock, 'AUTH PLAIN ' + authPlain(CFG.user, CFG.pass));
        await expect(sock, 235);
      }
    }

    await write(sock, `MAIL FROM:<${CFG.from}>`);
    await expect(sock, 250);
    await write(sock, `RCPT TO:<${addr}>`);
    await expect(sock, 250);
    await write(sock, 'DATA');
    await expect(sock, 354);

    const headers = [`From: ${CFG.from}`];
    if (replyTo) headers.push(`Reply-To: ${replyTo}`);
    const msg = buildMessage({ from: CFG.from, to: addr, subject, text });
    await write(sock, dotStuff(msg));
    await write(sock, '.');
    await expect(sock, 250);

    await write(sock, 'QUIT');
    await readReply(sock).catch(() => { /* server may close early; ignore */ });
    cleanup();
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (e) {
    cleanup();
    logger.warn(`smtp: send failed (${e.code || ''}): ${e.message}`);
    throw e;
  }
}

async function sendEhlo(sock) {
  await write(sock, `EHLO ${require('os').hostname() || 'othoni'}`);
  return expect(sock, 250);
}

module.exports = { isEnabled, snapshot, sendMail, parseMailto };
