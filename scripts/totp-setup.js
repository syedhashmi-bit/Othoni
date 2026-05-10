#!/usr/bin/env node
'use strict';

// One-shot helper to enroll TOTP for the othoni admin login.
// Usage:  node scripts/totp-setup.js   (or `npm run totp:setup`)
//
// Generates a random 160-bit base32 secret, prints the line you need to
// add to .env, and prints an otpauth:// URL you can paste into any
// authenticator app (or feed to a QR encoder like `qrencode -t UTF8`).

const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { generateSecret, otpauthURL } = require('../server/totp');

const user = process.env.OTHONI_ADMIN_USER || 'admin';
const issuer = `othoni:${require('os').hostname()}`;
const secret = generateSecret();
const url = otpauthURL(secret, { user, issuer });

const bar = '─'.repeat(60);
console.log('');
console.log(bar);
console.log('  othoni — TOTP enrollment');
console.log(bar);
console.log('');
console.log(`  user:   ${user}`);
console.log(`  issuer: ${issuer}`);
console.log('');
console.log('  1. Add this line to /var/www/othoni/.env :');
console.log('');
console.log(`       OTHONI_TOTP_SECRET=${secret}`);
console.log('');
console.log('  2. Restart the service so it picks up the new secret:');
console.log('');
console.log('       sudo systemctl restart othoni');
console.log('');
console.log('  3. Enroll your authenticator app — either scan a QR built');
console.log('     from this URL or paste the secret into "Add manually":');
console.log('');
console.log(`       ${url}`);
console.log('');

// If qrencode is on PATH, render an inline QR for convenience.
try {
  const qr = execSync(`qrencode -t UTF8 -m 1 -- ${JSON.stringify(url)}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  console.log('  Inline QR (requires monospace + dark terminal):');
  console.log('');
  console.log(qr.split('\n').map((l) => '    ' + l).join('\n'));
} catch {
  console.log('  (Install `qrencode` for an inline QR: apt install qrencode)');
  console.log('');
}

console.log(bar);
console.log('');
console.log('  Notes:');
console.log('   • Once OTHONI_TOTP_SECRET is set, every login requires the');
console.log('     6-digit code in addition to username + password.');
console.log('   • If you lose your authenticator, remove the env var and');
console.log('     restart to fall back to password-only login.');
console.log('   • The secret is sensitive — treat it like the JWT secret.');
console.log('');
