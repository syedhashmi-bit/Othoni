'use strict';

// Self-contained scrypt-based password hashing. Format:
//
//   scrypt$N=<n>,r=<r>,p=<p>$<base64-salt>$<base64-hash>
//
// Chosen because scrypt is a built-in Node primitive (no new deps —
// matches the project's no-extra-libs preference) and is a proper
// memory-hard KDF. Default cost params: N=32768, r=8, p=1, dkLen=32 —
// ~64 ms per verify on a small VPS, plenty for an interactive login.

const crypto = require('crypto');

const DEFAULTS = { N: 32768, r: 8, p: 1, dkLen: 32 };

function hashPassword(plaintext, opts = {}) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw Object.assign(new Error('password must be a non-empty string'), { code: 'invalid_password' });
  }
  const { N, r, p, dkLen } = { ...DEFAULTS, ...opts };
  const salt = crypto.randomBytes(16);
  const buf = crypto.scryptSync(plaintext, salt, dkLen, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${buf.toString('base64')}`;
}

// Constant-time verify. Returns true / false. Never throws on a malformed
// hash — we treat a bad stored hash the same as a wrong password (the caller
// is matching against an env-var-supplied value; surfacing parse errors would
// just leak info about the deployment).
function verifyPassword(plaintext, stored) {
  if (typeof plaintext !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const params = Object.fromEntries(
    parts[1].split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, parseInt(v, 10)];
    })
  );
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[2], 'base64');
    expected = Buffer.from(parts[3], 'base64');
  } catch {
    return false;
  }
  let derived;
  try {
    derived = crypto.scryptSync(plaintext, salt, expected.length, {
      N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// True iff the string parses as a valid scrypt hash. Used by auth.js to
// decide whether to take the hash path or the plaintext fallback.
function isHash(s) {
  return typeof s === 'string' && /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(s);
}

module.exports = { hashPassword, verifyPassword, isHash };
