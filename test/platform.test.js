'use strict';
/**
 * Smoke test with the real HAP library: discovery, services, state to characteristics,
 * commands from characteristic writes, cache pruning and redacted logging.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

let hap, PlatformAccessory;
try {
  hap = require('@homebridge/hap-nodejs');
  // homebridge's package "exports" only exposes the entry point, so load the class by file path.
  ({ PlatformAccessory } = require(path.join(path.dirname(require.resolve('homebridge')), 'platformAccessory.js')));
} catch (e) {
  hap = null; // homebridge is a devDependency; platform tests skip without it
}
const { DysonPlatform, PLUGIN_NAME, PLATFORM_NAME, CREDS_FILE } = require('../src/platform');

const SERIAL = 'AAA-AU-1234';

class FakeMqtt extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.sent = []; FakeMqtt.last = this; }
  async start() { this.started = true; }
  stop() { this.stopped = true; }
  async requestState() { this.sent.push(['legacy', { msg: 'REQUEST-CURRENT-STATE' }]); }
  async sendLegacy(m) { this.sent.push(['legacy', m]); }
  async callJdm(method, params) {
    this.sent.push(['jdm', method, params]);
    if (method === 'service.get_preference') {
      return { code: 0, data: { room: [[10, 'Hall', 0, 3, 0, 1, 0, 0, 0, 0, 1, 0]], uv_switch: [] } };
    }
    return { code: 0 };
  }
}
class FakeApi {
  constructor() {}
  async robots() { return [{ serial: SERIAL, name: 'Dyson Robot', productType: '804', version: '1', prefix: 'RB05' }]; }
  async iotCredentials() { return {}; }
}

function makeEnv(t, { cached = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  fs.writeFileSync(path.join(dir, CREDS_FILE), JSON.stringify({ token: 'abc-1', country: 'AU' }));
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: (m) => logs.push(m) };
  const registered = [];
  const unregistered = [];
  const api = Object.assign(new EventEmitter(), {
    hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: () => dir },
    registerPlatformAccessories: (p, pl, a) => registered.push(...a),
    unregisterPlatformAccessories: (p, pl, a) => unregistered.push(...a),
  });
  DysonPlatform.deps = { DysonApi: FakeApi, DysonMqtt: FakeMqtt };
  const platform = new DysonPlatform(log, { name: 'DysonRobot' }, api);
  cached.forEach((a) => platform.configureAccessory(a));
  t.after(() => { platform.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { platform, api, logs, registered, unregistered };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const S = () => hap.Service;
const C = () => hap.Characteristic;

test('discovers the robot and exposes the services', { skip: !hap && 'homebridge not installed' }, async (t) => {
  const env = makeEnv(t);
  env.api.emit('didFinishLaunching');
  await settle();
  assert.equal(env.registered.length, 1);
  assert.equal(FakeMqtt.last.started, true);
  const acc = env.registered[0];
  const subtypes = acc.services.filter((s) => s.subtype).map((s) => s.subtype).sort();
  assert.deepEqual(subtypes, ['battery', 'clean', 'docked', 'dry', 'empty', 'wash']);
  assert.equal(S().Switch.UUID, acc.getServiceById(S().Switch, 'clean').UUID);
});

test('reads fail while offline, then follow the robot state', { skip: !hap && 'homebridge not installed' }, async (t) => {
  const env = makeEnv(t);
  env.api.emit('didFinishLaunching');
  await settle();
  const acc = env.registered[0];
  const level = acc.getServiceById(S().Battery, 'battery').getCharacteristic(C().BatteryLevel);
  await assert.rejects(level.handleGetRequest());

  const link = FakeMqtt.last;
  link.emit('online', true);
  link.emit('state', {
    msg: 'CURRENT-STATE', state: 'INACTIVE_CHARGING', dockState: 'IDLE', batteryChargeLevel: 87,
    persistentMapId: '1', consumables: [{ type: 'brushBar', usage: 30 }],
    activeFaults: [{ faultCode: 2105, nextActionRequired: 'LOG_ONLY' }],
  });
  assert.equal(await level.handleGetRequest(), 87);
  const clean = acc.getServiceById(S().Switch, 'clean').getCharacteristic(C().On);
  assert.equal(await clean.handleGetRequest(), false);
  const docked = acc.getServiceById(S().ContactSensor, 'docked');
  assert.equal(await docked.getCharacteristic(C().ContactSensorState).handleGetRequest(), C().ContactSensorState.CONTACT_DETECTED);
  assert.equal(await docked.getCharacteristic(C().StatusFault).handleGetRequest(), C().StatusFault.NO_FAULT);
  const filter = acc.getServiceById(S().FilterMaintenance, 'filter-brushBar');
  assert.equal(filter.getCharacteristic(C().FilterLifeLevel).value, 70);

  link.emit('state', { msg: 'CURRENT-STATE', state: 'FULL_CLEAN_RUNNING', fullCleanAction: 'VACUUMING' });
  assert.equal(await clean.handleGetRequest(), true);

  link.emit('online', false); // GONE-AWAY: keep state, mark unavailable
  await assert.rejects(level.handleGetRequest());
});

test('Clean on runs the app sequence; Clean off sends Home; dock switch is refused mid-clean', { skip: !hap && 'homebridge not installed' }, async (t) => {
  const env = makeEnv(t);
  env.api.emit('didFinishLaunching');
  await settle();
  const acc = env.registered[0];
  const link = FakeMqtt.last;
  link.emit('online', true);
  link.emit('state', { msg: 'CURRENT-STATE', state: 'INACTIVE_CHARGING', dockState: 'IDLE', batteryChargeLevel: 100, persistentMapId: '1' });

  const clean = acc.getServiceById(S().Switch, 'clean').getCharacteristic(C().On);
  await clean.handleSetRequest(true);
  const kinds = link.sent.map((x) => (x[0] === 'jdm' ? x[1] : x[1].msg));
  assert.deepEqual(kinds.slice(-3), ['service.get_preference', 'service.set_preference', 'START']);

  link.emit('state', { msg: 'CURRENT-STATE', state: 'FULL_CLEAN_RUNNING' });
  const wash = acc.getServiceById(S().Switch, 'wash').getCharacteristic(C().On);
  await assert.rejects(wash.handleSetRequest(true));

  await clean.handleSetRequest(false);
  assert.equal(link.sent.at(-1)[1].msg, 'ABORT');
});

test('prunes services left by an older version', { skip: !hap && 'homebridge not installed' }, async (t) => {
  const uuid = hap.uuid.generate(`${PLUGIN_NAME}:${SERIAL}`);
  const old = new PlatformAccessory('Dyson Robot', uuid);
  old.addService(new hap.Service.Switch('Vacuum and Mop', 'vacuum-and-mop'));
  const env = makeEnv(t, { cached: [old] });
  env.api.emit('didFinishLaunching');
  await settle();
  assert.equal(env.registered.length, 0); // reused, not re-registered
  assert.equal(old.getServiceById(S().Switch, 'vacuum-and-mop'), undefined);
  assert.ok(old.getServiceById(S().Switch, 'clean'));
});

test('missing sign-in is reported, nothing starts; logs never contain secrets', { skip: !hap && 'homebridge not installed' }, async (t) => {
  const env = makeEnv(t);
  fs.rmSync(path.join(env.api.user.storagePath(), CREDS_FILE));
  env.api.emit('didFinishLaunching');
  await settle();
  assert.equal(env.registered.length, 0);
  assert.ok(env.logs.some((l) => /auth script/i.test(l)));

  env.platform.serials = [SERIAL];
  env.platform.warn(`serial ${SERIAL} token=abc Bearer ${'a'.repeat(32)}-1`);
  const last = env.logs.at(-1);
  assert.ok(!last.includes(SERIAL) && !last.includes('abc'));
});

test('plugin registers under the expected names', () => {
  const calls = [];
  require('../index.js')({ registerPlatform: (...a) => calls.push(a) });
  assert.equal(calls[0][0], PLUGIN_NAME);
  assert.equal(calls[0][1], PLATFORM_NAME);
  assert.equal(PLATFORM_NAME, 'DysonRobot');
});
