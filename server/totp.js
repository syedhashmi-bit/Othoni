'use strict';

// RFC 6238 TOTP / RFC 4648 base32. Pure-JS, no deps beyond Node `crypto`.
// Used by login() to second-factor a password if OTHONI_TOTP_SECRET is set.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  if (typeof input !== 'string') throw new Error('base32: not a string');
  const s = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(s[i]);
    if (idx === -1) throw new Error(`base32: invalid char ${s[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

// HOTP per RFC 4226 — counter-based one-time password.
function hotp(keyBuf, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  // Node's writeBigUInt64BE wants a BigInt; counter is a Number ≤ 2^53.
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
    ( hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, '0');
}

// TOTP at a specific unix-second time. Step defaults to 30s per RFC 6238.
function totpAt(secretB32, unixSeconds, { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(unixSeconds / step);
  return hotp(base32Decode(secretB32), counter, digits);
}

// Verify a 6-digit code against a secret. Accepts ±`window` 30s steps to
// tolerate clock drift (default 1 = ±30s). Constant-time across the whole
// window so a wrong code doesn't reveal which step matched.
function verifyTotp(secretB32, code, { step = 30, digits = 6, window = 1, now = Date.now() } = {}) {
  if (typeof code !== 'string' || !new RegExp(`^\\d{${digits}}$`).test(code)) {
    return false;
  }
  const t = Math.floor(now / 1000);
  const expectedCodes = [];
  for (let i = -window; i <= window; i++) {
    expectedCodes.push(totpAt(secretB32, t + i * step, { step, digits }));
  }
  let ok = false;
  const codeBuf = Buffer.from(code);
  for (const expected of expectedCodes) {
    const expectedBuf = Buffer.from(expected);
    // timingSafeEqual demands equal-length buffers — they always are for a
    // fixed digit count, but guard anyway.
    if (expectedBuf.length === codeBuf.length && crypto.timingSafeEqual(expectedBuf, codeBuf)) {
      ok = true;
      // intentionally don't `break` — we want timing constant across the loop
    }
  }
  return ok;
}

// Generate a 160-bit base32 secret (the size most authenticator apps default
// to and the size RFC 6238 recommends for SHA1).
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// otpauth:// URL most authenticator apps know how to scan / paste.
function otpauthURL(secretB32, { user = 'admin', issuer = 'othoni' } = {}) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(user)}`;
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  base32Decode,
  base32Encode,
  hotp,
  totpAt,
  verifyTotp,
  generateSecret,
  otpauthURL,
};
