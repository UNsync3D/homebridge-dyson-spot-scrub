#!/usr/bin/env node
'use strict';

/**
 * scripts/auth.js — One-time interactive authentication setup
 *
 * Run this ONCE before starting Homebridge for the first time:
 *
 *   node scripts/auth.js
 *
 * On Raspberry Pi / Linux with Homebridge installed as a service, run as root:
 *
 *   sudo node scripts/auth.js
 *
 * The script will ask for your Dyson account email, password, and country,
 * then save an auth token to the Homebridge storage directory.
 *
 * Auth flow:
 *   1. Tries the legacy v1 API (instant, no OTP).
 *   2. If that fails, uses the v3 OTP flow — a 6-digit code is emailed to you.
 *
 * You only need to run this once. The token is long-lived and will be reused
 * on every Homebridge restart.
 *
 * If you already have a bearer token (e.g. captured via Proxyman, or copied
 * from the ha-dyson-spot-scrub Home Assistant integration), you can skip the
 * interactive flow entirely:
 *
 *   node scripts/auth.js --token YOUR_BEARER_TOKEN_HERE
 */

const readline = require('readline');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const { DysonApi } = require('../src/dysonApi');

// ── Locate Homebridge storage ─────────────────────────────────────────────────
// Try common locations in priority order. The first one that exists wins.
// If none exist yet, fall back to ~/.homebridge (created if needed).

function findHomebridgeStorage() {
  const candidates = [
    '/var/lib/homebridge',          // Linux system service (most common on Pi)
    path.join(os.homedir(), '.homebridge'), // macOS / user install
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[candidates.length - 1]; // default: ~/.homebridge
}

const HB_STORAGE = findHomebridgeStorage();
const CRED_PATH  = path.join(HB_STORAGE, 'dyson-creds.json');

// ── Readline helpers ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function askPassword(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    let pw = '';

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      process.stdin.on('data', function handler(ch) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          if (ch === '') { process.stdout.write('\n'); process.exit(1); }
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(pw);
        } else if (ch === '' || ch === '\b') {
          pw = pw.slice(0, -1);
        } else {
          pw += ch;
        }
      });
    } else {
      // Non-TTY (piped input) — read normally
      rl.question('', (answer) => {
        process.stdout.write('\n');
        resolve(answer.trim());
      });
    }
  });
}

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Dyson HomeKit Plugin — One-Time Auth Setup ===\n');
  console.log(`Homebridge storage : ${HB_STORAGE}`);
  console.log(`Credentials file   : ${CRED_PATH}\n`);

  // Warn if running without write access
  try {
    fs.accessSync(HB_STORAGE, fs.constants.W_OK);
  } catch {
    console.error(`✗ Cannot write to ${HB_STORAGE}`);
    console.error('  Try running with sudo, or check the directory permissions.\n');
    process.exit(1);
  }

  // ── Fast path: --token flag ───────────────────────────────────────────────
  const pastedToken = getArg('--token');
  if (pastedToken) {
    console.log('Bearer token provided via --token flag.');

    if (fs.existsSync(CRED_PATH)) {
      const answer = (await ask('Existing credentials found. Overwrite? [y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('\nSetup cancelled — existing credentials kept.\n');
        rl.close();
        process.exit(0);
      }
      console.log();
    }

    if (!fs.existsSync(HB_STORAGE)) {
      fs.mkdirSync(HB_STORAGE, { recursive: true, mode: 0o700 });
    }
    DysonApi.saveCache(CRED_PATH, pastedToken);

    console.log('✓ Setup complete!');
    console.log(`  Credentials saved to: ${CRED_PATH}`);
    console.log('\nRestart Homebridge to activate the plugin:\n');
    console.log('  sudo systemctl restart homebridge\n');

    rl.close();
    process.exit(0);
  }

  // ── Interactive path: email + password ───────────────────────────────────

  // Check for existing credentials
  if (fs.existsSync(CRED_PATH)) {
    const answer = (await ask('Existing credentials found. Overwrite? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('\nSetup cancelled — existing credentials kept.\n');
      rl.close();
      process.exit(0);
    }
    console.log();
  }

  const email    = (await ask('Dyson account email:    ')).trim();
  const password = await askPassword('Dyson account password: ');
  const country  = (await ask('Country code (e.g. AU, GB, US, DE): ')).trim().toUpperCase() || 'GB';
  console.log();

  if (!email || !password) {
    console.error('✗ Email and password are required.');
    process.exit(1);
  }

  // ── Try v1 legacy auth first (no OTP) ────────────────────────────────────
  console.log('Trying direct authentication…');
  let token;
  try {
    token = await DysonApi.authenticateV1(email, password, country);
    console.log('  ✓ Authentication successful (no OTP needed)\n');
  } catch (v1Err) {
    console.log(`  ✗ Direct auth not available: ${v1Err.message}`);
    console.log('\nFalling back to OTP email flow…');

    // ── v3 OTP flow ─────────────────────────────────────────────────────────
    let challengeId;
    try {
      challengeId = await DysonApi.initiateV3Auth(email, password, country);
      console.log('  ✓ Check your email inbox — a 6-digit code has been sent');
    } catch (initErr) {
      console.error(`\n✗ Failed to start OTP flow: ${initErr.message}`);
      console.error('  Check your email address, password, and country code, then try again.');
      console.error('\n  Tip: if you already have a bearer token, skip this flow entirely:');
      console.error('       node scripts/auth.js --token YOUR_TOKEN_HERE');
      process.exit(1);
    }

    const otpCode = (await ask('\nEnter the 6-digit code from your email: ')).trim();
    console.log('\nVerifying code…');

    try {
      token = await DysonApi.verifyV3Auth(email, password, challengeId, otpCode);
      console.log('  ✓ OTP verified\n');
    } catch (verifyErr) {
      console.error(`\n✗ Verification failed: ${verifyErr.message}`);
      console.error('  The code may have expired — run the script again to get a fresh one.');
      process.exit(1);
    }
  }

  // Save token
  if (!fs.existsSync(HB_STORAGE)) {
    fs.mkdirSync(HB_STORAGE, { recursive: true, mode: 0o700 });
  }
  DysonApi.saveCache(CRED_PATH, token);

  console.log('✓ Setup complete!');
  console.log(`  Credentials saved to: ${CRED_PATH}`);
  console.log('\nRestart Homebridge to activate the plugin:\n');
  console.log('  sudo systemctl restart homebridge\n');

  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
