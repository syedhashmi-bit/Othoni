#!/usr/bin/env node
'use strict';

// Locked out? Sets a new random password for an account and prints it.
//
//   sudo node scripts/reset-password.js you@example.com
//   docker compose exec othoni node scripts/reset-password.js you@example.com
//
// Run it on the server, as the user othoni runs as (it edits
// data/accounts.json). Without an email it lists the accounts. With no
// accounts at all, restart othoni instead: it prints a fresh setup link.

const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const accounts = require('../server/accounts');

const email = process.argv[2];

if (!email) {
  const list = accounts.list();
  if (!list.length) {
    console.log('No accounts yet. Restart othoni and use the setup link it logs (or the code in data/setup-code).');
  } else {
    console.log('Accounts:');
    for (const a of list) console.log(`  ${a.email}  (${a.role}${a.disabled ? ', disabled' : ''})`);
    console.log('\nUsage: node scripts/reset-password.js <email>');
  }
  process.exit(0);
}

const account = accounts.findByEmail(email);
if (!account) {
  console.error(`No account for ${email}. Run without arguments to list them.`);
  process.exit(1);
}

// 16 chars from an alphabet without look-alikes; ~92 bits.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
let password = '';
for (let i = 0; i < 16; i++) password += ALPHABET[crypto.randomInt(ALPHABET.length)];

accounts.setPassword(account.id, password);
if (account.disabled) accounts.setDisabled(account.id, false);
console.log(`New password for ${account.email}: ${password}`);
console.log('Sign in with it, then change it under Settings → Access → Your password.');
if (account.disabled) console.log('(The account was disabled; it is enabled again.)');
