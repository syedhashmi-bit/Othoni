'use strict';

// First-run setup (v0.79). A fresh install has no accounts, so the first
// admin is created at /setup?code=…. The code is a one-time secret only
// someone with access to the server can read — the installer prints it,
// it's logged at startup, and it sits in data/setup-code (0600) — so
// whoever happens to reach a new instance first can't claim it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const accounts = require('./accounts');

const CODE_PATH = process.env.OTHONI_SETUP_CODE_PATH || path.join(__dirname, '..', 'data', 'setup-code');
// No 0/O or 1/I/L: the code gets read off a terminal and typed.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function needed() {
  return accounts.passwordLoginEnabled() && accounts.count() === 0;
}

function newCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function readCode() {
  try { return fs.readFileSync(CODE_PATH, 'utf8').trim() || null; } catch { return null; }
}

function discard() {
  try { fs.unlinkSync(CODE_PATH); } catch { /* already gone */ }
}

// Makes sure a code exists while setup is pending (keeping an existing one,
// so the installer's link stays valid across restarts) and removes a stale
// one once it isn't. Returns the code, or null when no setup is pending.
function ensure() {
  if (!needed()) {
    discard();
    return null;
  }
  let code = readCode();
  if (!code) {
    code = newCode();
    fs.mkdirSync(path.dirname(CODE_PATH), { recursive: true });
    fs.writeFileSync(CODE_PATH, code + '\n', { mode: 0o600 });
  }
  return code;
}

function normalize(c) {
  return typeof c === 'string' ? c.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

// Dashes, spaces and case don't matter — people retype these.
function check(code) {
  const expected = normalize(readCode());
  const given = normalize(code);
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Startup log line with the link. Points at OTHONI_PUBLIC_URL when there is
// one, otherwise at the address othoni listens on.
function logPending({ host, port }) {
  const code = ensure();
  if (!code) return;
  let base = (process.env.OTHONI_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    const h = !host || host === '0.0.0.0' || host === '::' ? '<this-server-ip>' : host;
    base = `http://${h}:${port}`;
  }
  logger.warn(`No accounts yet — create the first admin at ${base}/setup?code=${code} (the code is also in ${CODE_PATH})`);
}

module.exports = { needed, ensure, check, discard, logPending, CODE_PATH };
