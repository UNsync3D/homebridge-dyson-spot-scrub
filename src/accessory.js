'use strict';
/**
 * accessory.js: HomeKit services for one robot.
 *
 *   Switch "Clean"           On = clean in progress or paused; off sends Home; on while paused resumes
 *   Battery                  level, charging state, low battery
 *   FilterMaintenance xN     one per consumable
 *   Switch x3 (stateless)    Empty Bin, Wash Mop, Dry Mop; refused unless docked and idle
 *   ContactSensor "Docked"   closed = on the dock; also carries StatusActive and StatusFault,
 *                            because HAP's Switch has no StatusFault characteristic
 */
const { toHomeKit } = require('./robotState');
const { CommandRefused } = require('./robotController');

const DOCK_SWITCHES = [
  { name: 'Empty Bin', subtype: 'empty', action: 'COLLECT_DUST' },
  { name: 'Wash Mop', subtype: 'wash', action: 'WASH_MOP' },
  { name: 'Dry Mop', subtype: 'dry', action: 'DRY_MOP' },
];

const FILTER_NAMES = {
  brushBar: 'Brush Bar', mopRoller: 'Mop Roller', mopPad: 'Mop Pad',
  sideBrushes: 'Side Brushes', robotFilter: 'Robot Filter', dockFilter: 'Dock Filter',
};

class RobotAccessory {
  constructor({ api, accessory, controller, getMapId, exposeDockActions = true, model = 'Spot+Scrub AI' }) {
    this.api = api;
    this.S = api.hap.Service;
    this.C = api.hap.Characteristic;
    this.accessory = accessory;
    this.controller = controller;
    this.getMapId = getMapId;
    this.view = null;
    this.online = false;
    this.filters = new Map();
    this.keep = new Set(); // "<uuid>/<subtype>" of every service this version owns

    this.accessory.getService(this.S.AccessoryInformation)
      .setCharacteristic(this.C.Manufacturer, 'Dyson')
      .setCharacteristic(this.C.Model, model);

    // Clean
    this.clean = this.getOrAdd(this.S.Switch, 'Clean', 'clean');
    this.clean.getCharacteristic(this.C.On)
      .onGet(() => this.read(() => this.view.cleanOn))
      .onSet((v) => this.setClean(!!v));

    // Battery
    this.battery = this.getOrAdd(this.S.Battery, 'Battery', 'battery');
    this.battery.getCharacteristic(this.C.BatteryLevel).onGet(() => this.read(() => this.view.batteryLevel));
    this.battery.getCharacteristic(this.C.ChargingState).onGet(() => this.read(() => this.chargingValue()));
    this.battery.getCharacteristic(this.C.StatusLowBattery).onGet(() => this.read(() => this.lowValue()));

    // Docked, fault and online
    this.docked = this.getOrAdd(this.S.ContactSensor, 'Docked', 'docked');
    this.docked.getCharacteristic(this.C.ContactSensorState).onGet(() => this.read(() => this.dockedValue()));
    this.docked.getCharacteristic(this.C.StatusFault).onGet(() => this.read(() => this.faultValue()));
    this.docked.getCharacteristic(this.C.StatusActive).onGet(() => this.online);

    // Dock actions: stateless switches that always fall back to off
    if (exposeDockActions) {
      for (const d of DOCK_SWITCHES) {
        const svc = this.getOrAdd(this.S.Switch, d.name, d.subtype);
        svc.getCharacteristic(this.C.On)
          .onGet(() => false)
          .onSet((v) => this.runDockAction(svc, d.action, !!v));
      }
    }
    this.prune();
  }

  /** Call after every merged state change and on offline/online changes. */
  onState(state, online) {
    this.online = online;
    if (!online) {
      // Keep the last values on screen (reads fail with "No Response" meanwhile); don't push blanks from a cleared state.
      this.docked.updateCharacteristic(this.C.StatusActive, false);
      return;
    }
    this.view = toHomeKit(state);
    const v = this.view;
    this.clean.updateCharacteristic(this.C.On, v.cleanOn);
    this.battery.updateCharacteristic(this.C.BatteryLevel, v.batteryLevel);
    this.battery.updateCharacteristic(this.C.ChargingState, this.chargingValue());
    this.battery.updateCharacteristic(this.C.StatusLowBattery, this.lowValue());
    this.docked.updateCharacteristic(this.C.ContactSensorState, this.dockedValue());
    this.docked.updateCharacteristic(this.C.StatusFault, this.faultValue());
    this.docked.updateCharacteristic(this.C.StatusActive, online);
    for (const f of v.filters) {
      const svc = this.filterService(f.type);
      svc.updateCharacteristic(this.C.FilterLifeLevel, f.lifeLevel);
      svc.updateCharacteristic(this.C.FilterChangeIndication,
        f.changeNeeded ? this.C.FilterChangeIndication.CHANGE_FILTER : this.C.FilterChangeIndication.FILTER_OK);
    }
  }

  // ---- values ---------------------------------------------------------------------------------

  chargingValue() {
    return this.view.charging ? this.C.ChargingState.CHARGING : this.C.ChargingState.NOT_CHARGING;
  }
  lowValue() {
    return this.view.lowBattery ? this.C.StatusLowBattery.BATTERY_LEVEL_LOW : this.C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }
  dockedValue() {
    return this.view.docked ? this.C.ContactSensorState.CONTACT_DETECTED : this.C.ContactSensorState.CONTACT_NOT_DETECTED;
  }
  faultValue() {
    return this.view.fault ? this.C.StatusFault.GENERAL_FAULT : this.C.StatusFault.NO_FAULT;
  }

  // ---- handlers -------------------------------------------------------------------------------

  async setClean(on) {
    try {
      if (!on) return await this.controller.home();
      if (this.view && this.view.paused) return await this.controller.resume();
      const mapId = this.getMapId();
      if (!mapId) throw new CommandRefused('No map yet');
      await this.controller.startWholeHome(mapId);
    } catch (e) {
      this.fail(e);
    } finally {
      // Snap back to the robot's real state if it refused; onState corrects it if it accepted.
      const t = setTimeout(() => this.view && this.clean.updateCharacteristic(this.C.On, this.view.cleanOn), 3000);
      t.unref();
    }
  }

  async runDockAction(svc, action, on) {
    if (!on) return;
    try {
      await this.controller.dockAction(action);
    } catch (e) {
      this.fail(e);
    } finally {
      const t = setTimeout(() => svc.updateCharacteristic(this.C.On, false), 1000);
      t.unref();
    }
  }

  read(fn) {
    if (!this.online || !this.view) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return fn();
  }

  fail(e) {
    const { HapStatusError, HAPStatus } = this.api.hap;
    throw new HapStatusError(e instanceof CommandRefused ? HAPStatus.RESOURCE_BUSY : HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  // ---- service helpers ------------------------------------------------------------------------

  filterService(type) {
    let svc = this.filters.get(type);
    if (!svc) {
      svc = this.getOrAdd(this.S.FilterMaintenance, FILTER_NAMES[type] || type, `filter-${type}`);
      this.filters.set(type, svc);
    }
    return svc;
  }

  getOrAdd(Type, name, subtype) {
    this.keep.add(`${Type.UUID}/${subtype}`);
    let svc = this.accessory.getServiceById(Type, subtype);
    if (!svc) {
      svc = new Type(name, subtype);
      svc.setCharacteristic(this.C.Name, name);
      this.accessory.addService(svc);
    }
    return svc;
  }

  /** Drop services left over from an older version (for example the four mode switches). */
  prune() {
    const infoUuids = new Set([this.S.AccessoryInformation.UUID, this.S.ProtocolInformation.UUID]);
    for (const svc of [...this.accessory.services]) {
      if (infoUuids.has(svc.UUID)) continue;
      // Filter services appear later, once consumables arrive; keep any cached ones for now.
      if (svc.subtype && svc.subtype.startsWith('filter-')) {
        this.filters.set(svc.subtype.slice('filter-'.length), svc);
        continue;
      }
      if (!this.keep.has(`${svc.UUID}/${svc.subtype}`)) this.accessory.removeService(svc);
    }
  }
}

module.exports = { RobotAccessory };
