#!/usr/bin/env node
'use strict';

// One-shot helper to hash an admin password with scrypt.
// Usage:  node scripts/hash-password.js   (or `npm run hash-password`)
//
// Reads a password from stdin (silenced if attached to a TTY), computes a
// scrypt hash, and prints the line you need to add to .env. The hash format
// is self-describing — no separate salt to track.

const readline = require('readline');
const { hashPassword } = require('../server/password-hash');

function readPasswordFromTty(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Pipe / redirected: read whole input, strip trailing newline.
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      process.stdin.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute echo so the password doesn't appear on screen.
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.length > 0 && !chunk.includes('\n')) {
        return stdoutWrite('', ...rest);
      }
      return stdoutWrite(chunk, ...rest);
    };
    rl.question('', (answer) => {
      process.stdout.write = stdoutWrite;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

(async () => {
  const bar = '─'.repeat(60);
  console.log('');
  console.log(bar);
  console.log('  othoni — admin password hashing');
  console.log(bar);
  console.log('');
  const pw = await readPasswordFromTty('  password: ');
  if (!pw || pw.length < 1) {
    console.error('  empty password — aborting.');
    process.exit(1);
  }
  if (pw.length < 8) {
    console.error('  WARNING: password is shorter than 8 characters. Continue anyway? (Ctrl-C to abort.)');
  }
  const hash = hashPassword(pw);
  console.log('  Add this line to /var/www/othoni/.env :');
  console.log('');
  console.log(`     OTHONI_ADMIN_PASSWORD_HASH=${hash}`);
  console.log('');
  console.log('  Then comment out (or remove) the OTHONI_ADMIN_PASSWORD line and restart:');
  console.log('');
  console.log('     sudo systemctl restart othoni');
  console.log('');
  console.log('  The hash is salted; running this command again with the same');
  console.log('  password produces a different hash, by design.');
  console.log('');
})().catch((e) => {
  console.error('  ' + (e && e.message ? e.message : e));
  process.exit(1);
});
