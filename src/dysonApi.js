'use strict';

/**
 * dysonApi.js — Dyson cloud REST API client
 *
 * Auth flow (confirmed working Aug 2026):
 *   POST api.cp.dyson.com/v3/userregistration/email/auth?country={CC}  → challengeId (OTP email sent)
 *   POST api.cp.dyson.com/v3/userregistration/email/auth/verify        → { token, account }
 *
 * All subsequent REST calls use: Authorization: Bearer {token}
 *
 * IoT credentials (per device):
 *   POST appapi.cp.dyson.com/v2/authorize/iot-credentials
 *   Body: { "Serial": "{serial}" }
 *   → { IoTCredentials: { ClientId, TokenKey, TokenValue, TokenSignature, CustomAuthorizerName }, Endpoint }
 *
 * MQTT connection uses the custom authorizer via WebSocket:
 *   wss://{Endpoint}/mqtt?x-amz-customauthorizer-name={CustomAuthorizerName}
 *                       &token={TokenValue}
 *                       &x-amz-customauthorizer-signature={URL-encoded TokenSignature}
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const API_HOST    = 'appapi.cp.dyson.com';
const API_HOST_V3 = 'api.cp.dyson.com';

// Disable strict TLS — some platforms reject Dyson's cert chain without this
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

// AES-256-ECB key for decrypting LocalCredentials from the manifest
const LOCAL_CRED_KEY = Buffer.from(
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  'hex'
);

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(hostname, method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type':   'application/json',
      'User-Agent':     'Dalvik/2.1.0 (Linux; U; Android 11; Build/RQ3A.210905.001)',
      'Accept':         'application/json, text/plain, */*',
      'Accept-Language':'en-AU,en;q=0.9',
      ...extraHeaders,
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(
      { hostname, path: urlPath, method, headers, agent: httpsAgent },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Auth step helpers (used by auth.js script) ────────────────────────────────

/**
 * Try v1 legacy auth (no OTP). Returns Basic token string, or throws.
 */
async function authenticateV1(email, password, country = 'GB') {
  const res = await request(
    API_HOST, 'POST',
    `/v1/userregistration/authenticate?country=${country}`,
    { Email: email, Password: password }
  );
  if (res.status === 200 && res.data.Account && res.data.Password) {
    return Buffer.from(`${res.data.Account}:${res.data.Password}`).toString('base64');
  }
  const msg = typeof res.data === 'object' ? JSON.stringify(res.data) : res.data;
  throw new Error(`v1 auth failed (HTTP ${res.status}): ${msg}`);
}

/**
 * Start v3 OTP flow. Returns challengeId; an OTP email is sent.
 */
/**
 * Start v3 OTP flow. Returns challengeId; an OTP email is sent.
 * @param {string} country  Two-letter ISO country code, e.g. 'AU', 'GB', 'US'
 */
async function initiateV3Auth(email, password, country = 'GB') {
  const res = await request(
    API_HOST_V3, 'POST',
    `/v3/userregistration/email/auth?country=${country}`,
    { email, password, language: 'EN' }
  );
  if (res.status === 200 && res.data.challengeId) {
    return res.data.challengeId;
  }
  const msg = typeof res.data === 'object' ? JSON.stringify(res.data) : res.data;
  throw new Error(`v3 auth initiation failed (HTTP ${res.status}): ${msg}`);
}

/**
 * Verify OTP. Returns bearer token string.
 *
 * Dyson's v3 endpoint returns a direct bearer token in res.data.token.
 * Older responses may return account + password for Basic auth — we handle both.
 */
async function verifyV3Auth(email, password, challengeId, otpCode) {
  const res = await request(
    API_HOST_V3, 'POST',
    '/v3/userregistration/email/auth/verify',
    { email, password, challengeId, otpCode }
  );
  if (res.status === 200) {
    // Preferred: direct bearer token (confirmed v3 response format)
    if (res.data.token) return res.data.token;
    // Fallback: construct Basic token from account + password (older API versions)
    if (res.data.account && res.data.password) {
      return Buffer.from(`${res.data.account}:${res.data.password}`).toString('base64');
    }
  }
  const msg = typeof res.data === 'object' ? JSON.stringify(res.data) : res.data;
  throw new Error(`v3 OTP verification failed (HTTP ${res.status}): ${msg}`);
}

// ── Manifest / IoT ────────────────────────────────────────────────────────────

async function getManifest(token) {
  const res = await request(
    API_HOST, 'GET',
    '/v2/provisioningservice/manifest',
    null,
    { Authorization: `Bearer ${token}` }
  );
  if (res.status === 200 && Array.isArray(res.data)) {
    return res.data;
  }
  const msg = typeof res.data === 'object' ? JSON.stringify(res.data) : res.data;
  throw new Error(`Manifest fetch failed (HTTP ${res.status}): ${msg}`);
}

async function getIoTCredentials(token, serial) {
  const res = await request(
    API_HOST, 'POST',
    '/v2/authorize/iot-credentials',
    { Serial: serial },
    { Authorization: `Bearer ${token}` }
  );
  if (res.status !== 200) {
    const msg = typeof res.data === 'object' ? JSON.stringify(res.data) : res.data;
    throw new Error(`IoT credentials fetch failed (HTTP ${res.status}): ${msg}`);
  }
  const d   = res.data;
  const iot = d.IoTCredentials || d;
  return {
    endpoint:       d.Endpoint      || d.endpoint,
    tokenKey:       iot.TokenKey    || iot.tokenKey    || 'token',
    tokenValue:     iot.TokenValue  || iot.tokenValue,
    tokenSignature: iot.TokenSignature || iot.tokenSignature,
    clientId:       iot.ClientId    || iot.clientId,
    authorizerName: iot.CustomAuthorizerName || iot.authorizerName || 'cld-iot-credentials-lambda-authorizer',
  };
}

// ── Credential cache ──────────────────────────────────────────────────────────

function loadCache(credPath) {
  try {
    if (fs.existsSync(credPath)) {
      return JSON.parse(fs.readFileSync(credPath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function saveCache(credPath, token) {
  const data = { token, saved_at: Date.now() };
  fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function isTokenValid(token) {
  try {
    const res = await request(
      API_HOST, 'GET',
      '/v2/provisioningservice/manifest',
      null,
      { Authorization: `Bearer ${token}` }
    );
    return res.status === 200;
  } catch (_) {
    return false;
  }
}

// ── LocalCredentials decryption (for MQTT password) ──────────────────────────

function decryptLocalCredentials(encrypted) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-ecb', LOCAL_CRED_KEY, null);
    decipher.setAutoPadding(true);
    let dec = decipher.update(Buffer.from(encrypted, 'base64'));
    dec = Buffer.concat([dec, decipher.final()]);
    const parsed = JSON.parse(dec.toString('utf8'));
    return {
      serial:   parsed.serial   || parsed.Serial,
      password: parsed.apPasswordHash || parsed.LocalPassword || parsed.password,
    };
  } catch (_) {
    return { serial: null, password: encrypted };
  }
}

// ── DysonApi class (used by platform.js) ─────────────────────────────────────

class DysonApi {
  constructor(credPath, log) {
    this.credPath = credPath;
    this.log      = log;
    this.token    = null;
  }

  async ensureAuthenticated() {
    const cache = loadCache(this.credPath);
    if (cache && cache.token) {
      // Live validation is best-effort — some network environments block Dyson's
      // API endpoints. A genuinely expired token will surface when later calls fail.
      try { await isTokenValid(cache.token); } catch (_) {}
      this.token = cache.token;
      this.log.debug('DysonApi: using cached token');
      return;
    }
    throw new Error(
      'No valid Dyson credentials found. Run the one-time setup:\n' +
      `  node ${path.join(__dirname, '../scripts/auth.js')}\n` +
      'Then restart Homebridge.'
    );
  }

  async getDevices() {
    const devices = await getManifest(this.token);
    return devices;
  }

  async getIoTCredentials(serial) {
    return getIoTCredentials(this.token, serial);
  }

  // Exposed for auth script
  static authenticateV1  = authenticateV1;
  static initiateV3Auth  = initiateV3Auth;
  static verifyV3Auth    = verifyV3Auth;
  static saveCache       = saveCache;
  static decryptLocalCredentials = decryptLocalCredentials;
}

module.exports = { DysonApi };
