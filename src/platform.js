'use strict';
/**
 * platform.js: Homebridge dynamic platform. One accessory per supported robot on the Dyson account.
 */
const fs = require('node:fs');
const path = require('node:path');

const { DysonApi } = require('./dysonApi');
const { DysonMqtt } = require('./dysonMqtt');
const { RobotAccessory } = require('./accessory');
const { RobotController } = require('./robotController');
const { clearReadiness, detectModel, mergeState, redact } = require('./robotState');

const PLUGIN_NAME = 'homebridge-dyson-spot-scrub';
const PLATFORM_NAME = 'DysonRobot';
const CREDS_FILE = 'dyson-creds.json';
const OFFLINE_POLL_MS = 60000;

class DysonPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map(); // uuid -> cached PlatformAccessory
    this.robots = new Map(); // serial -> runtime
    this.serials = [];       // for log redaction

    this.refreshMs = clamp(Number(this.config.refreshIntervalSeconds ?? 30), 10, 300) * 1000;
    this.logMqtt = this.config.logMqtt === true;
    this.exposeDockActions = this.config.exposeDockActions !== false;

    api.on('didFinishLaunching', () => this.discover().catch((e) => this.warn(`Setup failed: ${e.message}`)));
    api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  // ---- logging (always redacted) --------------------------------------------------------------

  warn(msg) { this.log.warn(redact(msg, this.serials)); }
  info(msg) { this.log.info(redact(msg, this.serials)); }
  debug(msg) { if (this.logMqtt) this.log.info(redact(msg, this.serials)); }

  // ---- discovery ------------------------------------------------------------------------------

  readCreds() {
    const file = path.join(this.api.user.storagePath(), CREDS_FILE);
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (c.token && c.country) return c;
    } catch { /* fall through */ }
    return null;
  }

  async discover() {
    const creds = this.readCreds();
    if (!creds) {
      this.warn('Not signed in to Dyson. Run the auth script (see the README), then restart Homebridge.');
      return;
    }
    const { DysonApi: Api } = DysonPlatform.deps;
    const dyson = new Api({ country: creds.country, token: creds.token });

    let robots;
    try {
      robots = await dyson.robots();
    } catch (e) {
      if (e.status === 401) this.warn('Dyson rejected the saved sign-in. Run the auth script again.');
      else this.warn(`Could not list robots: ${e.message}`);
      return; // keep cached accessories; they show as not responding until this works
    }

    const only = Array.isArray(this.config.serials) && this.config.serials.length ? new Set(this.config.serials) : null;
    robots = robots.filter((r) => !only || only.has(r.serial));
    this.serials = robots.map((r) => r.serial);
    if (robots.length === 0) {
      this.warn('No supported robots found on this Dyson account.');
    }

    const seen = new Set();
    for (const r of robots) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${r.serial}`);
      seen.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(r.name || 'Dyson Robot', uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.set(uuid, accessory);
      }
      this.startRobot(r, accessory, dyson);
    }

    const stale = [...this.cached.entries()].filter(([uuid]) => !seen.has(uuid)).map(([, a]) => a);
    if (stale.length && robots.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.cached.delete(a.UUID));
    }
  }

  startRobot(r, accessory, dyson) {
    const { DysonMqtt: Mqtt } = DysonPlatform.deps;
    const model = detectModel(r.productType, r.prefix);
    const rt = { state: {}, online: false };
    const link = new Mqtt({
      serial: r.serial,
      prefix: r.prefix,
      getCredentials: () => dyson.iotCredentials(r.serial),
      logger: { debug: (m) => this.debug(m), warn: (m) => this.warn(m) },
    });
    const controller = new RobotController({
      link, model,
      getState: () => rt.state,
      isOnline: () => rt.online,
    });
    const view = new RobotAccessory({
      api: this.api, accessory, controller,
      getMapId: () => rt.state.persistentMapId,
      exposeDockActions: this.exposeDockActions,
      model: model === 'r2' ? 'R2 Nurovi Wash+Dry' : 'Spot+Scrub AI',
    });

    link.on('state', (msg) => {
      this.debug(`state ${JSON.stringify(msg)}`);
      rt.state = mergeState(rt.state, msg);
      view.onState(rt.state, rt.online);
    });
    link.on('prop', (data) => {
      // prop.post carries work_mode, which tells transitions like "finishing" (38) early.
      if (data && data.work_mode !== undefined) {
        rt.state = { ...rt.state, workMode: Number(data.work_mode) };
        view.onState(rt.state, rt.online);
      }
    });
    link.on('online', (online) => {
      if (rt.online === online) return;
      rt.online = online;
      this.info(online ? 'Robot online' : 'Robot offline');
      if (!online) {
        // Never authorise a new job from telemetry that predates the outage.
        rt.state = clearReadiness(rt.state);
        controller.cancelPendingStart();
      }
      view.onState(rt.state, rt.online);
    });
    link.on('error', (e) => this.warn(`MQTT: ${e.message}`));

    // The robot pushes changes but no regular snapshots, so ask every refresh interval, as the app does.
    rt.timer = setInterval(() => {
      if (rt.online) link.requestState().catch(() => {});
    }, this.refreshMs);
    rt.timer.unref();
    // While Dyson reports the robot gone, ask for its state once a minute until it answers.
    rt.offlineTimer = setInterval(() => {
      if (!rt.online) link.requestState().catch(() => {});
    }, OFFLINE_POLL_MS);
    rt.offlineTimer.unref();

    rt.link = link;
    this.robots.set(r.serial, rt);
    link.start().catch((e) => this.warn(`MQTT start failed: ${e.message}`));
  }

  shutdown() {
    for (const rt of this.robots.values()) {
      clearInterval(rt.timer);
      clearInterval(rt.offlineTimer);
      rt.link.stop();
    }
  }
}

DysonPlatform.deps = { DysonApi, DysonMqtt }; // replaceable in tests

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

module.exports = { DysonPlatform, PLUGIN_NAME, PLATFORM_NAME, CREDS_FILE };
