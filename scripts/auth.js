#!/usr/bin/env node
'use strict';
/**
 * Sign in to your Dyson account once and save the resulting token for the plugin.
 *
 *   node scripts/auth.js [--storage /path/to/homebridge]
 *
 * Your password and the one-time code are never saved. Only the token and country code are written,
 * to dyson-creds.json in the Homebridge storage folder (file mode 0600).
 *
 * Careful: a wrong password, a wrong code and a locked account all return the same HTTP 401, and repeated
 * failures lock the account for a while. If a step fails, wait a few minutes before trying again.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { DysonApi, DysonApiError, isCountryCode } = require('../src/dysonApi');
const { CREDS_FILE } = require('../src/platform');

function storageDir() {
  const i = process.argv.indexOf('--storage');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  if (process.env.UIX_STORAGE_PATH) return process.env.UIX_STORAGE_PATH;
  if (fs.existsSync('/var/lib/homebridge')) return '/var/lib/homebridge';
  return path.join(os.homedir(), '.homebridge');
}

function ask(rl, question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (hidden) {
      const write = rl._writeToOutput;
      rl._writeToOutput = () => {}; // do not echo the password
      rl.question(question, (answer) => {
        rl._writeToOutput = write;
        process.stdout.write('\n');
        resolve(answer.trim());
      });
      process.stdout.write(question);
    } else {
      rl.question(question, (answer) => resolve(answer.trim()));
    }
  });
}

async function main() {
  const dir = storageDir();
  if (!fs.existsSync(dir)) {
    console.error(`Storage folder not found: ${dir}\nPass the right one with --storage /path/to/homebridge`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const email = await ask(rl, 'Dyson account email: ');
    const country = (await ask(rl, 'Country code (for example AU, GB, US): ')).toUpperCase();
    if (!isCountryCode(country)) throw new DysonApiError('Country must be a two-letter code');
    const password = await ask(rl, 'Dyson account password (not shown, not saved): ', { hidden: true });

    const api = new DysonApi({ country });
    await api.appVersion();
    await api.userStatus(email);
    const challengeId = await api.startLogin(email);
    console.log('Dyson has emailed you a 6-digit code.');
    const otpCode = await ask(rl, 'Code: ');
    await api.verifyLogin({ email, password, challengeId, otpCode });

    const file = path.join(dir, CREDS_FILE);
    fs.writeFileSync(file, JSON.stringify({ token: api.token, country, savedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log(`Signed in. Token saved to ${file}. Restart Homebridge.`);
  } catch (e) {
    if (e instanceof DysonApiError && e.status === 401) {
      console.error('Dyson refused the sign-in. A wrong password, wrong code and locked account all look the same. Wait a few minutes before retrying.');
    } else {
      console.error(`Sign-in failed: ${e.message}`);
    }
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
