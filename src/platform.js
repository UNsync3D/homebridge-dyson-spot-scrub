'use strict';

/**
 * platform.js — Homebridge DynamicPlatformPlugin for Dyson robots
 *
 * On startup:
 *   1. Load cached Dyson credentials (from scripts/auth.js first-time setup)
 *   2. Fetch IoT credentials from Dyson REST API
 *   3. Discover devices from the device manifest
 *   4. For each robot device, open an MQTT connection and register an accessory
 *
 * Accessories persist in Homebridge's cache between restarts so their UUIDs
 * (and HomeKit pairings) survive reboots.
 */

const path = require('path');
const { DysonApi }           = require('./dysonApi');
const { DysonMqtt }          = require('./dysonMqtt');
const { DysonRobotAccessory } = require('./accessory');

// Product types Dyson uses for robot vacuums — used to filter manifest results
// RB05 is the Spot & Scrub. Add other product codes here as they're discovered.
const ROBOT_PRODUCT_TYPES = new Set(['RB05', '804', 'N223', 'N224', 'N225', 'N226']);

// mqttRootTopicLevel values that indicate a robot vacuum
// Fallback: use product type mapping above if manifest doesn't include it
const PRODUCT_MQTT_PREFIX = {
  '804': 'RB05',   // Spot & Scrub (confirmed)
};

class DysonPlatform {
  constructor(log, config, api) {
    this.log    = log;
    this.config = config || {};
    this.api    = api;

    this.accessories = new Map();  // UUID → PlatformAccessory (restored from cache)
    this.mqttClients = new Map();  // serial → DysonMqtt

    // Credential cache lives in Homebridge's storage directory
    this.credPath = path.join(api.user.storagePath(), 'dyson-creds.json');

    this.log.info('DysonPlatform initialised');

    // Homebridge fires 'didFinishLaunching' once it has restored cached accessories
    this.api.on('didFinishLaunching', this._init.bind(this));
    this.api.on('shutdown', this._shutdown.bind(this));
  }

  // ── Homebridge lifecycle ───────────────────────────────────────────────────

  /**
   * Called by Homebridge to restore a cached accessory from a previous session.
   * We store it in the map and update it during _init.
   */
  configureAccessory(accessory) {
    // Strip invalid HAP characters from cached names (legacy devices may have ™, + etc.)
    accessory.displayName = accessory.displayName
      .replace(/[™®©℠+]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  async _init() {
    const dysonApi = new DysonApi(this.credPath, this.log);

    try {
      await dysonApi.ensureAuthenticated();
    } catch (err) {
      this.log.error('DysonPlatform: ' + err.message);
      return;
    }

    // Discover devices first
    let devices;
    try {
      devices = await dysonApi.getDevices();
      this.log.info(`Found ${devices.length} device(s) in manifest`);
    } catch (err) {
      this.log.error(`Failed to fetch device manifest: ${err.message}`);
      return;
    }

    // Filter to robot vacuums only
    // v2 manifest uses PascalCase fields — normalise to camelCase
    const normalised = devices.map(d => ({
      serial:              d.Serial      || d.serial,
      name:                d.Name        || d.name,
      productType:         d.ProductType || d.productType,
      mqttRootTopicLevel:  d.mqttRootTopicLevel,
      version:             d.Version     || d.version,
      localCredentials:    d.LocalCredentials || d.localCredentials,
    }));
    const robots = normalised.filter(d => this._isRobot(d));
    if (robots.length === 0) {
      this.log.warn('No robot vacuums found in your Dyson account manifest.');
      return;
    }

    // Register each robot — IoT credentials fetched per device (includes serial in request)
    for (const device of robots) {
      let iotCreds;
      try {
        iotCreds = await dysonApi.getIoTCredentials(device.serial);
        this.log.debug(`[${device.serial}] Got IoT credentials for endpoint: ${iotCreds.endpoint}`);
      } catch (err) {
        this.log.error(`[${device.serial}] Failed to fetch IoT credentials: ${err.message}`);
        continue;
      }
      await this._registerDevice(device, iotCreds);
    }

    // Remove cached accessories that no longer exist in the manifest
    const activeUuids = new Set(
      robots.map(d => this.api.hap.uuid.generate(d.serial))
    );
    for (const [uuid, accessory] of this.accessories) {
      if (!activeUuids.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories('homebridge-dyson-robot', 'DysonRobot', [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  async _registerDevice(device, iotCreds) {
    const serial = device.serial;
    const uuid   = this.api.hap.uuid.generate(serial);

    // Determine MQTT topic prefix
    const mqttPrefix = device.mqttRootTopicLevel
      || PRODUCT_MQTT_PREFIX[device.productType]
      || 'RB05';

    // HomeKit only allows letters, numbers, spaces, apostrophes and basic punctuation.
    // Strip anything else (™, emoji, etc.) so HAP-NodeJS doesn't warn on every restart.
    const safeName = (device.name || `Dyson ${serial}`)
      .replace(/[^\w\s'.,!?-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      || `Dyson ${serial}`;

    this.log.info(`Registering robot: ${safeName} (${serial}, prefix: ${mqttPrefix})`);

    // Get or create the Homebridge PlatformAccessory
    let platformAccessory = this.accessories.get(uuid);
    let isNew = false;

    if (!platformAccessory) {
      platformAccessory = new this.api.platformAccessory(safeName, uuid);
      isNew = true;
    }

    // Open MQTT connection
    const mqttClient = new DysonMqtt({
      serial,
      mqttPrefix,
      iotCreds,
      log:     this.log,
      verbose: this.config.logMqtt || false,
    });

    try {
      await mqttClient.connect();
    } catch (err) {
      this.log.error(`[${serial}] MQTT connect failed: ${err.message}`);
      return;
    }

    this.mqttClients.set(serial, mqttClient);

    // Attach the accessory handler
    new DysonRobotAccessory(this, platformAccessory, device, mqttClient);

    // Register new accessories with Homebridge
    if (isNew) {
      this.accessories.set(uuid, platformAccessory);
      this.api.registerPlatformAccessories(
        'homebridge-dyson-robot',
        'DysonRobot',
        [platformAccessory]
      );
      this.log.info(`[${serial}] Accessory registered`);
    } else {
      this.api.updatePlatformAccessories([platformAccessory]);
      this.log.info(`[${serial}] Accessory updated`);
    }
  }

  // ── Shutdown ────────────────────────────────────────────────────────────────

  _shutdown() {
    this.log.info('DysonPlatform shutting down');
    for (const client of this.mqttClients.values()) {
      client.disconnect();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _isRobot(device) {
    // Check by known MQTT prefix (most reliable)
    if (device.mqttRootTopicLevel && device.mqttRootTopicLevel.startsWith('RB')) return true;
    // Fallback: check product type
    if (ROBOT_PRODUCT_TYPES.has(device.productType)) return true;
    return false;
  }
}

module.exports = { DysonPlatform };
