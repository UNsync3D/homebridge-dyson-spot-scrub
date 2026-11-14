'use strict';
/**
 * robotController.js: command layer on top of a link (see dysonMqtt.js).
 * Link contract: sendLegacy(msg) and callJdm(method, params) -> {code, data}.
 *
 * The room start is the sequence the Home Assistant integration uses on live robots:
 * get_preference, set_preference (wait for code 0), then only the legacy START. The cloud adds
 * set_cur_map and set_room_clean itself; sending them too made the robot start, stop and start again.
 *
 * Rules: ready check before and after each wait, stale USER_CONTINUE faults don't block a start,
 * dock actions only when docked and idle, Pause/Home cancel a start in preparation, one start at a time.
 */
const { canDockAction, canStart, timestamp } = require('./robotState');

class CommandRefused extends Error {}
class Cancelled extends Error {}

const MIN_ROOM_ROW_LEN = 11; // a usable row reaches index [10] (order)
const R2_SENT_ROW_LEN = 11;  // the R2 app sends 11 values although the robot reports a 12th

function validRoomRow(row) {
  return Array.isArray(row) && row.length >= MIN_ROOM_ROW_LEN
    && (typeof row[0] === 'number' || typeof row[0] === 'string');
}

class RobotController {
  constructor({ link, getState, isOnline, model, getInventory }) {
    this.link = link;
    this.getState = getState;
    this.isOnline = isOnline;
    this.model = model;
    // Optional async (mapNum) => Map(room id -> name) from Dyson's REST map metadata, or null when unavailable.
    this.getInventory = getInventory;
    this.startInFlight = false;
    this.stopCounter = 0;
    // get_preference is not a complete room list: after a scheduled clean it can hold only that room.
    // Rooms are therefore remembered per map and merged, never dropped.
    this.roomStore = new Map(); // map id -> Map(room id -> row)
  }

  /** The app has no whole-home clean, so whole home means selecting every known room. */
  startWholeHome(mapId) {
    return this.startRooms(mapId, null);
  }

  /** roomIds = null means every room. Each room is cleaned with its saved settings. */
  async startRooms(mapId, roomIds) {
    const mapNum = Number(mapId);
    if (mapId === undefined || mapId === null || mapId === '' || !Number.isInteger(mapNum)) {
      throw new CommandRefused('The current map is not known yet');
    }
    if (this.startInFlight) throw new CommandRefused('A start is already being prepared');
    this.ready(); // fail fast

    this.startInFlight = true; // held from get_preference through START
    const myStop = this.stopCounter;
    const stillWanted = () => {
      if (this.stopCounter !== myStop) throw new Cancelled();
    };

    try {
      const pref = await this.link.callJdm('service.get_preference', { map_id: mapNum });
      stillWanted();
      if (!pref || (pref.code !== undefined && pref.code !== 0)) {
        throw new CommandRefused('The robot did not return its room settings');
      }
      const data = pref.data || {};
      // The reply is matched to our request by msgId, so map_id is only a cross-check when present.
      if (data.map_id !== undefined && Number(data.map_id) !== mapNum) {
        throw new CommandRefused('Room settings came back for a different map');
      }
      const fresh = data.room; // the reply's key is `room`; set_preference takes `room_preference`
      if (!Array.isArray(fresh) || fresh.length === 0 || !fresh.every(validRoomRow)) {
        throw new CommandRefused('The robot returned incomplete room settings');
      }

      const store = this.mergeRooms(mapNum, fresh);
      const inventory = await this.inventoryFor(mapNum);
      stillWanted();
      if (inventory) {
        // Dyson's own list is authoritative: forget rooms that no longer exist on this map ...
        for (const id of [...store.keys()]) if (!inventory.has(id)) store.delete(id);
        // ... and don't quietly clean "everything" when the robot only told us about some rooms.
        const missing = [...inventory.keys()].filter((id) => !store.has(id));
        if (roomIds === null && missing.length > 0) {
          throw new CommandRefused(`The robot reported only ${store.size} of ${inventory.size} rooms; try again later`);
        }
      }
      const rows = [...store.values()];
      const known = new Set(rows.map((r) => String(r[0])));
      const wanted = roomIds ? roomIds.map(String) : rows.map((r) => String(r[0]));
      if (wanted.length === 0 || new Set(wanted).size !== wanted.length || wanted.some((id) => !known.has(id))) {
        throw new CommandRefused('A requested room is unknown or repeated');
      }
      const wantedSet = new Set(wanted);
      // Only "selected" [8] changes. Names, order and every other setting are sent back as they were.
      const outgoing = rows.map((row) => {
        const copy = [...row];
        copy[8] = wantedSet.has(String(copy[0])) ? 1 : 0;
        return this.model === 'r2' ? copy.slice(0, R2_SENT_ROW_LEN) : copy;
      });

      this.ready();
      const saved = await this.link.callJdm('service.set_preference', {
        map_id: mapNum,
        prefer_type: 1,
        room_preference: outgoing,
        uv_switch: data.uv_switch || [], // sent back unchanged
      });
      stillWanted();
      if (!saved || saved.code !== 0) throw new CommandRefused('The robot did not confirm the room settings');

      // Readiness may have changed while we waited; the app also stops roller drying just before a clean.
      const again = this.ready();
      if (again.needsAbortDry) {
        await this.link.sendLegacy({ msg: 'ABORT-DOCK-ACTION', action: 'DRY_MOP', 'mode-reason': 'RAPP', time: now() });
      }
      await this.link.sendLegacy({
        msg: 'START',
        'mode-reason': 'RAPP',
        cleaningMode: 'zoneConfigured',
        cleaningProgramme: { persistentMapId: String(mapNum), unorderedZones: wanted },
        time: now(),
      });
    } catch (e) {
      if (e instanceof Cancelled) return; // Pause or Home cancelled a start still being prepared
      throw e;
    } finally {
      this.startInFlight = false;
    }
  }

  async pause() {
    this.stopCounter++;
    await this.link.sendLegacy({ msg: 'PAUSE', 'mode-reason': 'RAPP', time: now() });
  }

  /** No legacy resume exists (a START would begin a new clean). The app sends this JDM call alone. */
  async resume() {
    await this.link.callJdm('service.set_room_clean', { ctrl_value: 1, clean_type: 0, room_ids: [] });
  }

  /** Home: stop and return to the dock. Legacy only; the cloud adds start_recharge itself. */
  async home() {
    this.stopCounter++;
    await this.link.sendLegacy({ msg: 'ABORT', 'mode-reason': 'RAPP', time: now() });
  }

  /** The Home Assistant integration sends STOP; the protocol notes don't list it. The HomeKit tiles use Home. */
  async stop() {
    this.stopCounter++;
    await this.link.sendLegacy({ msg: 'STOP', 'mode-reason': 'RAPP', time: now() });
  }

  /** action: COLLECT_DUST | WASH_MOP | DRY_MOP */
  async dockAction(action) {
    const check = canDockAction(this.getState(), this.isOnline());
    if (!check.ok) throw new CommandRefused(check.reason);
    await this.link.sendLegacy({ msg: 'START-DOCK-ACTION', action, time: now() });
  }

  /** A start still being prepared is dropped (the robot went offline, or the connection was lost). */
  cancelPendingStart() {
    this.stopCounter++;
  }

  ready() {
    const check = canStart(this.getState(), this.isOnline());
    if (!check.ok) throw new CommandRefused(check.reason);
    return check;
  }

  mergeRooms(mapNum, fresh) {
    const key = String(mapNum);
    const store = this.roomStore.get(key) || new Map();
    for (const row of fresh) store.set(String(row[0]), [...row]); // newest reply wins; a replaced room keeps its place
    this.roomStore.set(key, store);
    return store;
  }

  /** The REST room list, or null if it isn't wired up or the call fails (then the robot's replies are all we have). */
  async inventoryFor(mapNum) {
    if (!this.getInventory) return null;
    try {
      return (await this.getInventory(mapNum)) || null;
    } catch {
      return null;
    }
  }
}

function now() {
  return timestamp();
}

module.exports = { RobotController, CommandRefused };
