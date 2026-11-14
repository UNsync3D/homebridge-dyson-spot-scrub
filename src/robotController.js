'use strict';
/**
 * robotController.js: command layer on top of a link (see dysonMqtt.js).
 * Link contract: sendLegacy(msg) and callJdm(method, params) -> {code, data}.
 *
 * Rules: 1 ready check, 2 stale-fault start, 3 dock actions only when idle,
 * 5 Pause and Home cancel a start in preparation, 6 one start at a time, 8 never trust a reply for the wrong map.
 */
const { canDockAction, canStart, timestamp } = require('./robotState');

class CommandRefused extends Error {}
class Cancelled extends Error {}

class RobotController {
  constructor({ link, getState, isOnline, model }) {
    this.link = link;
    this.getState = getState;
    this.isOnline = isOnline;
    this.model = model;
    this.startInFlight = false;
    this.stopCounter = 0;
  }

  /** The app has no whole-home clean, so whole home means selecting every room. */
  startWholeHome(mapId) {
    return this.startRooms(mapId, null);
  }

  /** roomIds = null means every room. Each room is cleaned with its saved settings. */
  async startRooms(mapId, roomIds) {
    if (this.startInFlight) throw new CommandRefused('A start is already being prepared');
    const check = canStart(this.getState(), this.isOnline());
    if (!check.ok) throw new CommandRefused(check.reason);

    this.startInFlight = true; // held from get_preference through START
    const myStop = this.stopCounter;
    const stillWanted = () => {
      if (this.stopCounter !== myStop) throw new Cancelled();
    };

    try {
      if (check.needsAbortDry) {
        await this.link.sendLegacy({ msg: 'ABORT-DOCK-ACTION', action: 'DRY_MOP', time: now() });
      }
      const pref = await this.link.callJdm('service.get_preference', { map_id: mapId });
      stillWanted();
      const data = (pref && pref.data) || {};
      if (String(data.map_id) !== String(mapId)) {
        throw new CommandRefused('Room settings came back for a different map');
      }
      const rows = data.room_preference || []; // ASSUMPTION: field name, confirm against a capture
      const allIds = rows.map((r) => Number(r[0]));
      const chosen = roomIds || allIds;
      if (chosen.length === 0) throw new CommandRefused('No rooms on this map');

      await this.link.callJdm('service.set_preference', {
        map_id: mapId,
        prefer_type: data.prefer_type !== undefined ? data.prefer_type : 1, // echoed back; 1 only if the reply had none
        room_preference: this.markSelection(rows, chosen),
        uv_switch: data.uv_switch || [], // sent back unchanged
      });
      stillWanted();

      await this.link.sendLegacy({
        msg: 'START',
        'mode-reason': 'RAPP',
        time: now(),
        cleaningMode: 'zoneConfigured',
        fullCleanType: 'immediate',
        cleaningProgramme: {
          persistentMapId: mapId,
          zonesDefinitionLastUpdatedDate: '',
          unorderedZones: chosen.map(String),
        },
      });
    } catch (e) {
      if (e instanceof Cancelled) return; // Pause, Stop or Home cancelled a start still being prepared
      throw e;
    } finally {
      this.startInFlight = false;
    }
  }

  async pause() {
    this.stopCounter++;
    await this.link.sendLegacy({ msg: 'PAUSE', 'mode-reason': 'RAPP', time: now() });
  }

  /** No legacy resume exists (a START would begin a new clean), so this is the JDM call alone. */
  async resume() {
    await this.link.callJdm('service.set_room_clean', { ctrl_value: 1 });
  }

  /** Home: stop and return to the dock. The protocol notes list no extra fields; confirm on a live robot. There is no STOP message. */
  async home() {
    this.stopCounter++;
    await this.link.sendLegacy({ msg: 'ABORT', 'mode-reason': 'RAPP', time: now() });
  }

  /** action: COLLECT_DUST | WASH_MOP | DRY_MOP */
  async dockAction(action) {
    const check = canDockAction(this.getState(), this.isOnline());
    if (!check.ok) throw new CommandRefused(check.reason);
    await this.link.sendLegacy({ msg: 'START-DOCK-ACTION', action, time: now() });
  }

  /** Chosen rooms get selected = 1 (index 8) and the first order slots (index 10). The R2 takes 11 values. */
  markSelection(rows, chosen) {
    let next = chosen.length + 1;
    return rows.map((row) => {
      const copy = [...row];
      const pos = chosen.indexOf(Number(copy[0]));
      copy[8] = pos >= 0 ? 1 : 0;
      copy[10] = pos >= 0 ? pos + 1 : next++;
      return this.model === 'r2' ? copy.slice(0, 11) : copy;
    });
  }
}

function now() {
  return timestamp();
}

module.exports = { RobotController, CommandRefused };
