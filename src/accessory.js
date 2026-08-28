'use strict';

/**
 * accessory.js — Homebridge accessory for one Dyson robot vacuum/mop
 *
 * Exposes six HomeKit services:
 *
 *   1. Switch "Vacuum"            — ON starts vacuum-only clean (mode 0)
 *   2. Switch "Vacuum and Mop"    — ON starts vacuum + mop simultaneous (mode 1)
 *   3. Switch "Mop"               — ON starts mop-only clean (mode 2)
 *   4. Switch "Vacuum then Mop"   — ON starts vacuum-then-mop sequential (mode 3)
 *      All four: OFF → return to base
 *   5. BatteryService             — charge level, low-battery alert, charging state
 *   6. ContactSensor              — CLOSED = docked, OPEN = away
 *
 * State is kept in sync by listening to MQTT stateChange events.
 */

const {
  isVacuumingOnly, isVacuumingAndMopping, isMopping, isVacuumThenMop,
  isDocked, isCharging, batteryLevel, hasFault,
} = require('./dysonMqtt');

class DysonRobotAccessory {
  constructor(platform, accessory, device, mqttClient) {
    this.platform  = platform;
    this.accessory = accessory;
    this.device    = device;
    this.mqtt      = mqttClient;
    this.log       = platform.log;
    this.hap       = platform.api.hap;

    const { Service, Characteristic } = this.hap;

    // ── Migrate: remove any legacy Switch services without a subtype ──────────
    // Before multi-mode support, the plugin registered a single unsubtyped Switch.
    // Homebridge caches it — we must explicitly remove it here so it disappears
    // from HomeKit rather than showing as a phantom extra switch.
    for (const svc of [...accessory.services]) {
      if (svc.UUID === Service.Switch.UUID && !svc.subtype) {
        this.log.debug(`[${device.serial}] Removing legacy unsubtyped Switch service`);
        accessory.removeService(svc);
      }
    }

    // ── Accessory Information ─────────────────────────────────────────────────
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Dyson')
      .setCharacteristic(Characteristic.Model,        device.productType || 'Robot Vacuum')
      .setCharacteristic(Characteristic.SerialNumber, device.serial)
      .setCharacteristic(Characteristic.FirmwareRevision, device.version || '1.0.0');

    // ── Vacuum switch (subtype: 'vacuum') ─────────────────────────────────────
    this.vacuumService = accessory.getService('vacuum')
      || accessory.addService(Service.Switch, 'Vacuum', 'vacuum');
    this.vacuumService.setCharacteristic(Characteristic.Name, 'Vacuum');
    this.vacuumService.setCharacteristic(Characteristic.ConfiguredName, 'Vacuum');
    this.vacuumService.getCharacteristic(Characteristic.On)
      .onGet(this._getVacuumOn.bind(this))
      .onSet(this._setVacuumOn.bind(this));

    // ── Vacuum and Mop switch (subtype: 'vacuum-mop') ────────────────────────
    this.vacuumMopService = accessory.getService('vacuum-mop')
      || accessory.addService(Service.Switch, 'Vacuum and Mop', 'vacuum-mop');
    this.vacuumMopService.setCharacteristic(Characteristic.Name, 'Vacuum and Mop');
    this.vacuumMopService.setCharacteristic(Characteristic.ConfiguredName, 'Vacuum and Mop');
    this.vacuumMopService.getCharacteristic(Characteristic.On)
      .onGet(this._getVacuumMopOn.bind(this))
      .onSet(this._setVacuumMopOn.bind(this));

    // ── Mop switch (subtype: 'mop') ───────────────────────────────────────────
    this.mopService = accessory.getService('mop')
      || accessory.addService(Service.Switch, 'Mop', 'mop');
    this.mopService.setCharacteristic(Characteristic.Name, 'Mop');
    this.mopService.setCharacteristic(Characteristic.ConfiguredName, 'Mop');
    this.mopService.getCharacteristic(Characteristic.On)
      .onGet(this._getMopOn.bind(this))
      .onSet(this._setMopOn.bind(this));

    // ── Vacuum then Mop switch (subtype: 'vacuum-then-mop') ──────────────────
    this.vacuumThenMopService = accessory.getService('vacuum-then-mop')
      || accessory.addService(Service.Switch, 'Vacuum then Mop', 'vacuum-then-mop');
    this.vacuumThenMopService.setCharacteristic(Characteristic.Name, 'Vacuum then Mop');
    this.vacuumThenMopService.setCharacteristic(Characteristic.ConfiguredName, 'Vacuum then Mop');
    this.vacuumThenMopService.getCharacteristic(Characteristic.On)
      .onGet(this._getVacuumThenMopOn.bind(this))
      .onSet(this._setVacuumThenMopOn.bind(this));

    // ── Battery service ───────────────────────────────────────────────────────
    this.batteryService = accessory.getService(Service.Battery)
      || accessory.addService(Service.Battery);
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(this._getBatteryLevel.bind(this));
    this.batteryService.getCharacteristic(Characteristic.ChargingState)
      .onGet(this._getChargingState.bind(this));
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(this._getLowBattery.bind(this));

    // ── ContactSensor — docked/away ───────────────────────────────────────────
    this.dockService = accessory.getService(Service.ContactSensor)
      || accessory.addService(Service.ContactSensor, 'Dock');
    this.dockService.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(this._getDocked.bind(this));

    // ── MQTT state listener ───────────────────────────────────────────────────
    this.mqtt.on('stateChange', this._onStateChange.bind(this));
    this.mqtt.on('disconnected', () => {
      this.log.warn(`[${device.serial}] MQTT disconnected — HomeKit values may be stale`);
    });

    // Periodic refresh
    const interval = (platform.config.refreshIntervalSeconds || 30) * 1000;
    this._refreshTimer = setInterval(() => {
      if (this.mqtt.connected) this.mqtt.requestCurrentState();
    }, interval);

    this.log.debug(`[${device.serial}] Accessory ready (4 switches)`);
  }

  // ── Characteristic getters ────────────────────────────────────────────────

  _getVacuumOn()        { return isVacuumingOnly(this.mqtt.state); }
  _getVacuumMopOn()     { return isVacuumingAndMopping(this.mqtt.state); }
  _getMopOn()           { return isMopping(this.mqtt.state); }
  _getVacuumThenMopOn() { return isVacuumThenMop(this.mqtt.state); }

  _getBatteryLevel() { return batteryLevel(this.mqtt.state) ?? 0; }

  _getChargingState() {
    const { ChargingState } = this.hap.Characteristic;
    return isCharging(this.mqtt.state) ? ChargingState.CHARGING : ChargingState.NOT_CHARGING;
  }

  _getLowBattery() {
    const { StatusLowBattery } = this.hap.Characteristic;
    const level = batteryLevel(this.mqtt.state);
    return (level !== null && level < 20)
      ? StatusLowBattery.BATTERY_LEVEL_LOW
      : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  _getDocked() {
    const { ContactSensorState } = this.hap.Characteristic;
    return isDocked(this.mqtt.state)
      ? ContactSensorState.CONTACT_DETECTED
      : ContactSensorState.CONTACT_NOT_DETECTED;
  }

  // ── Switch setters ────────────────────────────────────────────────────────

  async _setVacuumOn(value) {
    if (value) { this._clearPendingOff(); this.mqtt.startMode(0); }
    else        { this._setPendingOff('vacuum'); this.mqtt.returnToBase(); }
  }

  async _setVacuumMopOn(value) {
    if (value) { this._clearPendingOff(); this.mqtt.startMode(1); }
    else        { this._setPendingOff('vacuumMop'); this.mqtt.returnToBase(); }
  }

  async _setMopOn(value) {
    if (value) { this._clearPendingOff(); this.mqtt.startMode(2); }
    else        { this._setPendingOff('mop'); this.mqtt.returnToBase(); }
  }

  async _setVacuumThenMopOn(value) {
    if (value) { this._clearPendingOff(); this.mqtt.startMode(3); }
    else        { this._setPendingOff('vacuumThenMop'); this.mqtt.returnToBase(); }
  }

  // Optimistic OFF helpers — suppress snap-back for up to 15 s while robot transitions
  _setPendingOff(mode) {
    this._pendingOff = mode;
    if (this._pendingOffTimer) clearTimeout(this._pendingOffTimer);
    this._pendingOffTimer = setTimeout(() => { this._pendingOff = null; }, 15000);
  }

  _clearPendingOff() {
    this._pendingOff = null;
    if (this._pendingOffTimer) clearTimeout(this._pendingOffTimer);
  }

  // ── MQTT state → HomeKit push ─────────────────────────────────────────────

  _onStateChange(state) {
    const { Characteristic } = this.hap;

    const vacuumOnly    = isVacuumingOnly(state);
    const vacuumAndMop  = isVacuumingAndMopping(state);
    const mopOnly       = isMopping(state);
    const vacuumThenMop = isVacuumThenMop(state);
    const anyCleaning   = vacuumOnly || vacuumAndMop || mopOnly || vacuumThenMop;

    if (!anyCleaning && this._pendingOff) this._clearPendingOff();

    if (this._pendingOff !== 'vacuum' || !vacuumOnly)
      this.vacuumService.getCharacteristic(Characteristic.On).updateValue(vacuumOnly);
    if (this._pendingOff !== 'vacuumMop' || !vacuumAndMop)
      this.vacuumMopService.getCharacteristic(Characteristic.On).updateValue(vacuumAndMop);
    if (this._pendingOff !== 'mop' || !mopOnly)
      this.mopService.getCharacteristic(Characteristic.On).updateValue(mopOnly);
    if (this._pendingOff !== 'vacuumThenMop' || !vacuumThenMop)
      this.vacuumThenMopService.getCharacteristic(Characteristic.On).updateValue(vacuumThenMop);

    const level = batteryLevel(state);
    if (level !== null) {
      this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(level);
      this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(
        level < 20
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }
    this.batteryService.getCharacteristic(Characteristic.ChargingState).updateValue(
      isCharging(state) ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING
    );
    this.dockService.getCharacteristic(Characteristic.ContactSensorState).updateValue(
      isDocked(state)
        ? Characteristic.ContactSensorState.CONTACT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );

    if (this.platform.config.logMqtt) {
      this.log.debug(
        `[${this.device.serial}] state=${state.state} action=${state.fullCleanAction || 'unknown'} ` +
        `sweepType=${state.sweepType ?? 'n/a'} battery=${level}% docked=${isDocked(state)} fault=${hasFault(state)}`
      );
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    clearInterval(this._refreshTimer);
    this._clearPendingOff();
    this.mqtt.removeAllListeners('stateChange');
  }
}

module.exports = { DysonRobotAccessory };
