'use strict';

/**
 * dysonMqtt.js — Dyson MQTT connection manager
 *
 * Connects to Dyson's AWS IoT Core broker over WebSocket (port 443).
 *
 * Four cleaning modes (sent via startMode):
 *   0 = Vacuum only        — set_preference mode 0, clean_type 0
 *   1 = Vacuum + Mop       — set_preference mode 1, clean_type 0
 *   2 = Mop only           — clean_type 2 (no preference needed)
 *   3 = Vacuum then Mop    — set_preference mode 3, clean_type 0
 *
 * State detection key:
 *   fullCleanAction       VACUUMING | VACUUMING_AND_MOPPING | MOPPING | NONE
 *   sweepType (from JDM)  7 = vacuum-then-mop sequential, 0 = all others
 */

const mqtt         = require('mqtt');
const EventEmitter = require('events');

const COMMANDS = {
  START:                 'START',
  STOP:                  'STOP',
  ABORT:                 'ABORT',
  REQUEST_CURRENT_STATE: 'REQUEST-CURRENT-STATE',
};

// Room preference mode values (room_preference array index 3)
const PREF_MODE = {
  VACUUM:          0,
  VACUUM_AND_MOP:  1,
  MOP:             2,   // not used — we send clean_type:2 instead
  VACUUM_THEN_MOP: 3,
};

class DysonMqtt extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.serial
   * @param {string}  opts.mqttPrefix
   * @param {object}  opts.iotCreds
   * @param {object}  opts.log
   * @param {boolean} opts.verbose
   */
  constructor({ serial, mqttPrefix, iotCreds, log, verbose = false }) {
    super();
    this.serial    = serial;
    this.prefix    = mqttPrefix;
    this.iotCreds  = iotCreds;
    this.log       = log;
    this.verbose   = verbose;

    this.client    = null;
    this.connected = false;
    this.state     = {};

    // Room preferences — populated after first CURRENT-STATE with a persistentMapId
    this._cachedPreference   = null;
    this._preferencesFetched = false;
  }

  // ── Topic helpers ──────────────────────────────────────────────────────────

  get commandTopic()    { return `${this.prefix}/${this.serial}/command`; }
  get jdmCommandTopic() { return `${this.prefix}/${this.serial}/command/jdm`; }
  get wildcardTopic()   { return `${this.prefix}/${this.serial}/#`; }

  // ── Connection ─────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      const { endpoint, tokenValue, tokenSignature, clientId, authorizerName } = this.iotCreds;
      const wsUrl = (
        `wss://${endpoint}/mqtt` +
        `?x-amz-customauthorizer-name=${encodeURIComponent(authorizerName)}` +
        `&token=${encodeURIComponent(tokenValue)}` +
        `&x-amz-customauthorizer-signature=${encodeURIComponent(tokenSignature)}`
      );

      this.log.debug(`[${this.serial}] MQTT connecting to ${endpoint}:443`);
      this.client = mqtt.connect(wsUrl, {
        clientId,
        keepalive:       30,
        clean:           true,
        reconnectPeriod: 5000,
        connectTimeout:  30000,
        rejectUnauthorized: false,
        wsOptions: { family: 4, rejectUnauthorized: false },
      });

      this.client.once('connect', () => {
        this.log.info(`[${this.serial}] MQTT connected`);
        this.connected = true;
        this.client.subscribe(this.wildcardTopic, { qos: 0 }, (err) => {
          if (err) { this.log.error(`[${this.serial}] Subscribe failed: ${err.message}`); }
          else      { this.requestCurrentState(); }
        });
        this.emit('connected');
        resolve();
      });

      this.client.on('reconnect', () => {
        this.log.debug(`[${this.serial}] MQTT reconnecting…`);
        this.connected = false;
      });
      this.client.on('offline', () => {
        this.log.warn(`[${this.serial}] MQTT offline`);
        this.connected = false;
        this.emit('disconnected');
      });
      this.client.on('error', (err) => {
        this.log.error(`[${this.serial}] MQTT error: ${err.message}`);
        reject(err);
        reject = () => {};
      });
      this.client.on('message', (topic, payload) => {
        this._handleMessage(topic, payload);
      });
    });
  }

  disconnect() {
    if (this.client) { this.client.end(true); this.client = null; this.connected = false; }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  _handleMessage(topic, payload) {
    let data;
    try { data = JSON.parse(payload.toString()); } catch { return; }
    if (this.verbose) { this.log.info(`[MQTT in ] ${topic}: ${JSON.stringify(data)}`); }

    // ── JDM status/jdm ─────────────────────────────────────────────────────
    if (topic.endsWith('/status/jdm')) {
      // prop.post — robot pushing live state deltas
      if (data.method === 'prop.post' && data.params) {
        this._mergeJdmProps(data.params);
      }
      // prop.get response — full JDM property snapshot (response to our request)
      if (data.method === 'prop.get' && data.code !== undefined && data.data) {
        this._mergeJdmProps(data.data);
      }
      // Room preferences response
      if (data.method === 'service.get_preference' && data.code === 0 && data.data) {
        this._cachedPreference = data.data;
        const n = (data.data.room || []).length;
        this.log.info(`[${this.serial}] Room preferences cached (${n} room(s))`);
      }
      return;
    }

    // ── High-level /status ──────────────────────────────────────────────────
    if (topic.endsWith('/status') || topic.endsWith('/status/current')) {
      const msg = data.msg || data.method;

      if (msg === 'CURRENT-STATE' || msg === 'STATE-CHANGE' ||
          msg === 'PRODUCT_INFO'  || msg === 'INITIAL_STATE') {
        this.state = { ...this.state, ...data };
        this.emit('stateChange', this.state);

        // Fetch room preferences once we know the map ID
        if (!this._preferencesFetched && this.state.persistentMapId) {
          this._preferencesFetched = true;
          this._fetchRoomPreferences();
        }
      } else if (data.faultId !== undefined) {
        this.log.warn(`[${this.serial}] Fault ${data.faultId} — status: ${data.status}`);
        this.emit('fault', data);
      }
    }
  }

  /**
   * Merge JDM property fields we care about into this.state.
   * sweep_type === 7 is the signal for vacuum-then-mop sequential mode.
   */
  _mergeJdmProps(props) {
    const updates = {};
    if (props.sweep_type !== undefined) updates.sweepType = props.sweep_type;
    if (props.work_mode  !== undefined) updates.workMode  = props.work_mode;
    if (props.status     !== undefined) updates.jdmStatus = props.status;
    if (Object.keys(updates).length > 0) {
      this.state = { ...this.state, ...updates };
      this.emit('stateChange', this.state);
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  requestCurrentState() {
    this._publish({
      msg:  COMMANDS.REQUEST_CURRENT_STATE,
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }

  /**
   * Fetch room preferences via JDM and cache them.
   * Called automatically after the first CURRENT-STATE that includes persistentMapId.
   */
  _fetchRoomPreferences() {
    const mapId = parseInt(this.state.persistentMapId);
    if (isNaN(mapId)) return;
    this.log.debug(`[${this.serial}] Fetching room preferences for map ${mapId}`);
    this._publishRaw(this.jdmCommandTopic, {
      msgId:   String(Math.floor(Math.random() * 4294967295)),
      version: '1.0.1',
      method:  'service.get_preference',
      params:  { map_id: mapId },
      time:    new Date().toISOString(),
    });
  }

  /**
   * Start cleaning in one of four modes.
   *
   * @param {number} mode
   *   0 = Vacuum only
   *   1 = Vacuum + Mop (simultaneous)
   *   2 = Mop only
   *   3 = Vacuum then Mop (sequential)
   */
  startMode(mode) {
    const labels = ['vacuum only', 'vacuum + mop', 'mop only', 'vacuum then mop'];
    const label  = labels[mode] ?? `mode ${mode}`;
    this.log.info(`[${this.serial}] → START (${label})`);

    // Mop-only uses clean_type: 2 directly — no room preference needed
    if (mode === PREF_MODE.MOP) {
      this._publish({
        msg:          COMMANDS.START,
        'mode-reason': 'RAPP',
        cleaningMode: 'global',
        time:         new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
      this._publishJdm('service.set_room_clean', { ctrl_value: 1, clean_type: 2, room_ids: [] });
      return;
    }

    // All other modes need the room preference cache
    if (!this._cachedPreference?.room?.length) {
      this.log.warn(`[${this.serial}] Room preferences not yet available — retrying in 2 s`);
      setTimeout(() => this.startMode(mode), 2000);
      return;
    }

    const pref    = this._cachedPreference;
    const mapId   = parseInt(this.state.persistentMapId);
    const roomIds = pref.room.map(r => r[0]);          // numeric IDs for set_room_clean
    const zoneIds = roomIds.map(String);               // string IDs for /command START

    // Update preference mode for every room (index 3), keep 11 elements for SET
    const updatedRooms = pref.room.map(room => {
      const r = [...room].slice(0, 11);
      r[3] = mode;
      return r;
    });

    // 1. Set room preferences to the desired mode
    this._publishJdm('service.set_preference', {
      map_id:          mapId,
      prefer_type:     1,
      room_preference: updatedRooms,
      uv_switch:       pref.uv_switch || [],
    });

    // 2. High-level START (zone-configured — mirrors what the Dyson app sends)
    this._publish({
      msg:              COMMANDS.START,
      'mode-reason':    'RAPP',
      cleaningMode:     'zoneConfigured',
      cleaningProgramme: {
        persistentMapId: String(mapId),
        unorderedZones:  zoneIds,
      },
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });

    // 3. Set current map
    this._publishJdm('service.set_cur_map', { map_id: mapId });

    // 4. Low-level start (clean_type: 0 = follow room preference)
    this._publishJdm('service.set_room_clean', { ctrl_value: 1, clean_type: 0, room_ids: roomIds });
  }

  /**
   * Stop cleaning (robot stays in place).
   */
  stop() {
    this.log.info(`[${this.serial}] → STOP`);
    this._publish({
      msg:          COMMANDS.STOP,
      'mode-reason': 'RAPP',
      time:         new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }

  /**
   * Return to dock.
   * Confirmed from capture: app sends ABORT + service.start_recharge.
   */
  returnToBase() {
    this.log.info(`[${this.serial}] → RETURN_TO_BASE`);
    this._publish({
      msg:          'ABORT',
      'mode-reason': 'RAPP',
      time:         new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    this._publishJdm('service.start_recharge', {});
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _publishJdm(method, params) {
    const msgId = String(Math.floor(Math.random() * 4294967295));
    this._publishRaw(this.jdmCommandTopic, {
      msgId, version: '1.0.1', method, params, time: new Date().toISOString(),
    });
  }

  _publish(payload) { this._publishRaw(this.commandTopic, payload); }

  _publishRaw(topic, payload) {
    if (!this.client || !this.connected) {
      this.log.warn(`[${this.serial}] Cannot publish — not connected`);
      return;
    }
    const json = JSON.stringify(payload);
    if (this.verbose) { this.log.info(`[MQTT out] ${topic}: ${json}`); }
    this.client.publish(topic, json, { qos: 0 });
  }
}

// ── State helpers ──────────────────────────────────────────────────────────────

const RUNNING_STATES = new Set([
  'FULL_CLEAN_RUNNING',
  'FULL_CLEAN_PAUSED',       // paused mid-clean (e.g. waste tank full)
  'FULL_CLEAN_DISCOVERING',  // navigating to cleaning zone
  'MAPPING_N_CLEANING',
  'ZONE_CLEANING_RUNNING',
  'SPOT_CLEANING_RUNNING',
]);

const CHARGING_STATES = new Set([
  'CHARGING',
  'FULL_CLEAN_CHARGING',
  'INACTIVE_CHARGING',       // docked + fully charged
]);

function isRunning(state) { return RUNNING_STATES.has(state.state); }

/**
 * Vacuum-then-Mop sequential mode.
 * Detected via sweep_type === 7 (confirmed from MQTT capture).
 * Active during BOTH the vacuuming phase AND the subsequent mopping phase.
 */
function isVacuumThenMop(state) {
  return isRunning(state) && state.sweepType === 7;
}

/**
 * Vacuum-only mode (sweep_type !== 7 rules out the vacuum phase of vacuum-then-mop).
 */
function isVacuumingOnly(state) {
  return isRunning(state) && state.fullCleanAction === 'VACUUMING' && state.sweepType !== 7;
}

/**
 * Vacuum + Mop simultaneous (fullCleanAction is unambiguous for this mode).
 */
function isVacuumingAndMopping(state) {
  return isRunning(state) && state.fullCleanAction === 'VACUUMING_AND_MOPPING';
}

/**
 * Mop-only mode (sweep_type !== 7 rules out the mopping phase of vacuum-then-mop).
 */
function isMopping(state) {
  return isRunning(state) && state.fullCleanAction === 'MOPPING' && state.sweepType !== 7;
}

/** @deprecated Use isVacuumingOnly or isVacuumingAndMopping */
function isVacuuming(state) { return isVacuumingOnly(state) || isVacuumingAndMopping(state); }

function isDocked(state) {
  return CHARGING_STATES.has(state.state)
    || state.dockState === 'DOCKED'
    || state.dockState === 'DRYING_MOP'
    || state.dockState === 'WASHING_MOP';
}

function isCharging(state) { return CHARGING_STATES.has(state.state) && isDocked(state); }

function batteryLevel(state) {
  const b = state.batteryChargeLevel;
  return (typeof b === 'number') ? Math.max(0, Math.min(100, b)) : null;
}

function hasFault(state) {
  const faults = state.activeFaults;
  if (!Array.isArray(faults) || faults.length === 0) return false;
  return faults.some(f => f.status !== 'LOG_ONLY');
}

module.exports = {
  DysonMqtt, PREF_MODE,
  isRunning, isVacuuming, isVacuumingOnly, isVacuumingAndMopping, isMopping, isVacuumThenMop,
  isDocked, isCharging, batteryLevel, hasFault,
};
