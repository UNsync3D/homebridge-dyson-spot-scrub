#!/usr/bin/env node
'use strict';

/**
 * capture.js — Raw MQTT message capture for Dyson robot
 *
 * Connects to the Dyson MQTT broker using your cached credentials and
 * prints every message received on RB05/{serial}/#  to stdout.
 *
 * Usage:
 *   node scripts/capture.js
 *
 * Run this while using the Dyson app to capture the raw MQTT traffic.
 */

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const mqtt  = require('mqtt');

// ── Load cached token ──────────────────────────────────────────────────────

const STORAGE_CANDIDATES = [
  '/var/lib/homebridge',
  path.join(require('os').homedir(), '.homebridge'),
];

function findCredPath() {
  for (const dir of STORAGE_CANDIDATES) {
    const p = path.join(dir, 'dyson-creds.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const credPath = findCredPath();
if (!credPath) {
  console.error('No dyson-creds.json found. Run scripts/auth.js first.');
  process.exit(1);
}

const { token } = JSON.parse(fs.readFileSync(credPath, 'utf8'));
if (!token) {
  console.error('dyson-creds.json has no token. Re-run scripts/auth.js.');
  process.exit(1);
}

// ── Fetch manifest + IoT creds ─────────────────────────────────────────────

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function request(hostname, method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent':   'Dalvik/2.1.0 (Linux; U; Android 11; Build/RQ3A.210905.001)',
      ...extraHeaders,
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(
      { hostname, path: urlPath, method, headers, agent: httpsAgent },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
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

async function main() {
  // 1. Fetch device manifest
  console.log('Fetching device manifest…');
  const manifestRes = await request(
    'appapi.cp.dyson.com', 'GET',
    '/v2/provisioningservice/manifest', null,
    { Authorization: `Bearer ${token}` }
  );
  if (manifestRes.status !== 200 || !Array.isArray(manifestRes.data)) {
    console.error('Manifest fetch failed:', manifestRes.status, manifestRes.data);
    process.exit(1);
  }

  // Find first robot (RB prefix)
  const robots = manifestRes.data.filter(d => {
    const prefix = d.mqttRootTopicLevel || '';
    return prefix.startsWith('RB') || ['804'].includes(d.ProductType);
  });

  if (robots.length === 0) {
    console.error('No robot devices found in manifest.');
    process.exit(1);
  }

  const device = robots[0];
  const serial = device.Serial || device.serial;
  const prefix = device.mqttRootTopicLevel || 'RB05';
  console.log(`Device: ${device.Name || serial}  serial: ${serial}  prefix: ${prefix}`);

  // 2. Fetch IoT credentials
  console.log('Fetching IoT credentials…');
  const iotRes = await request(
    'appapi.cp.dyson.com', 'POST',
    '/v2/authorize/iot-credentials',
    { Serial: serial },
    { Authorization: `Bearer ${token}` }
  );
  if (iotRes.status !== 200) {
    console.error('IoT credentials fetch failed:', iotRes.status, iotRes.data);
    process.exit(1);
  }

  const d   = iotRes.data;
  const iot = d.IoTCredentials || d;
  const endpoint       = d.Endpoint      || d.endpoint;
  const tokenValue     = iot.TokenValue  || iot.tokenValue;
  const tokenSignature = iot.TokenSignature || iot.tokenSignature;
  const clientId       = iot.ClientId    || iot.clientId;
  const authorizerName = iot.CustomAuthorizerName || 'cld-iot-credentials-lambda-authorizer';

  // 3. Connect to MQTT and log everything
  const wsUrl = (
    `wss://${endpoint}/mqtt` +
    `?x-amz-customauthorizer-name=${encodeURIComponent(authorizerName)}` +
    `&token=${encodeURIComponent(tokenValue)}` +
    `&x-amz-customauthorizer-signature=${encodeURIComponent(tokenSignature)}`
  );

  const wildcardTopic = `${prefix}/${serial}/#`;
  console.log(`\nConnecting to ${endpoint}:443`);
  console.log(`Subscribing to ${wildcardTopic}\n`);
  console.log('─'.repeat(72));
  console.log('Now use the Dyson app to start cleaning in different modes.');
  console.log('Every MQTT message will appear below. Press Ctrl+C to stop.');
  console.log('─'.repeat(72) + '\n');

  const client = mqtt.connect(wsUrl, {
    clientId,
    keepalive:       30,
    clean:           true,
    reconnectPeriod: 5000,
    connectTimeout:  30000,
    rejectUnauthorized: false,
    wsOptions: { family: 4, rejectUnauthorized: false },
  });

  client.on('connect', () => {
    console.log('[connected]\n');
    client.subscribe(wildcardTopic, { qos: 0 });
  });

  client.on('message', (topic, payload) => {
    const ts = new Date().toTimeString().slice(0, 8);
    let data;
    try { data = JSON.parse(payload.toString()); } catch { data = payload.toString(); }
    console.log(`[${ts}] ${topic}`);
    console.log(JSON.stringify(data, null, 2));
    console.log();
  });

  client.on('error', err => {
    console.error('[error]', err.message);
  });

  client.on('offline', () => console.log('[offline]'));
  client.on('reconnect', () => console.log('[reconnecting…]'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
