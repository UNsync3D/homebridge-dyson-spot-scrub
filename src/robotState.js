'use strict';
/**
 * robotState.js: pure state handling for the Spot+Scrub AI (RB05) and R2 (RB07).
 * No Homebridge or MQTT imports. Rules come from the protocol and porting notes.
 */

/** Product type / MQTT prefix detection. */
function detectModel(productType, prefix) {
  if (String(productType) === '804' || prefix === 'RB05') return 'spot-scrub-ai';
  if (String(productType) === '914' || prefix === 'RB07') return 'r2';
  return 'unknown';
}

/** Faults that must never be shown or block anything. */
const LOG_ONLY_CODES = new Set(['2105', '2103', '22016']);

function actionableFaults(s) {
  return (s.activeFaults || []).filter(
    (f) => f.nextActionRequired !== 'LOG_ONLY' && !LOG_ONLY_CODES.has(String(f.faultCode)),
  );
}

/** Merge a CURRENT-STATE / STATE-CHANGE payload. Position-only pushes have no `state`, so merge, never replace. */
function mergeState(prev, patch) {
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'msg' || k === 'time' || k === 'mode-reason') continue;
    next[k] = v;
  }
  return next;
}

const READY_STATES = new Set(['INACTIVE_CHARGING', 'INACTIVE_CHARGED', 'INACTIVE_DISCHARGING', 'CHARGING']);

/** Robot on the dock and idle. DRYING_MOP counts as idle: a start interrupts it. */
function isDockedAndIdle(s) {
  return (
    READY_STATES.has(String(s.state)) &&
    (s.dockState === undefined || s.dockState === 'IDLE' || s.dockState === 'DRYING_MOP') &&
    s.workMode !== 38
  );
}

/** Rule 1 + rule 2: only start when ready, but allow a start past a stale USER_CONTINUE fault. */
function canStart(s, online) {
  if (!online) return { ok: false, reason: 'Robot is offline' };
  if (s.state === undefined) return { ok: false, reason: 'No state received yet' };
  if (!isDockedAndIdle(s)) return { ok: false, reason: `Not ready (${s.state}, dock ${s.dockState})` };
  const blocking = actionableFaults(s).filter((f) => f.nextActionRequired !== 'USER_CONTINUE');
  if (blocking.length > 0) return { ok: false, reason: `Fault ${blocking[0].faultCode}` };
  return { ok: true, needsAbortDry: s.dockState === 'DRYING_MOP' };
}

/** Rule 3: dock actions only while docked and the dock isn't busy. */
function canDockAction(s, online) {
  if (!online) return { ok: false, reason: 'Robot is offline' };
  if (!isDockedAndIdle(s) || (s.dockState !== undefined && s.dockState !== 'IDLE')) {
    return { ok: false, reason: 'Robot must be docked and the dock idle' };
  }
  return { ok: true };
}

/** Rule 4: ABORTED / FINISHED mean "driving back", not "done". */
function isReturning(s) {
  return s.state === 'FULL_CLEAN_ABORTED' || s.state === 'FULL_CLEAN_FINISHED' || s.workMode === 38;
}

const LOW_BATTERY_PERCENT = 20;
const FILTER_CHANGE_AT_LIFE_PERCENT = 10;

/** ASSUMPTION: consumable `usage` is percent used (0..100). Verify against the HA integration's const.py. */
function toHomeKit(s) {
  const returning = isReturning(s);
  const running = s.state === 'FULL_CLEAN_RUNNING' || s.state === 'FULL_CLEAN_CHARGING';
  const paused = s.state === 'FULL_CLEAN_PAUSED';
  const battery = clamp(Number(s.batteryChargeLevel ?? 0), 0, 100);
  return {
    cleanOn: !returning && (running || paused),
    paused,
    batteryLevel: battery,
    charging: s.state === 'INACTIVE_CHARGING' || s.state === 'CHARGING' || s.state === 'FULL_CLEAN_CHARGING',
    lowBattery: battery <= LOW_BATTERY_PERCENT,
    docked: isDockedAndIdle(s) || s.dockState === 'WASHING_MOP' || s.dockState === 'COLLECTING_DUST',
    fault: actionableFaults(s).length > 0,
    filters: (s.consumables || [])
      .filter((c) => c.type !== 'cleaningSolution' && typeof c.usage === 'number')
      .map((c) => {
        const lifeLevel = clamp(100 - c.usage, 0, 100);
        return { type: c.type, lifeLevel, changeNeeded: lifeLevel <= FILTER_CHANGE_AT_LIFE_PERCENT };
      }),
  };
}

/** Redact secrets for logs: tokens, localpwd, emails, serials, and clean IDs (second half is the serial in hex). */
function redact(text, serials = []) {
  let out = String(text)
    .replace(/"localpwd"\s*:\s*"[^"]*"/gi, '"localpwd":"[redacted]"')
    .replace(/Bearer\s+[0-9a-f]{16,}-1/gi, 'Bearer [redacted]')
    .replace(/\b[0-9a-f]{24,}-1\b/gi, '[token]')
    .replace(/(token|x-amz-customauthorizer-signature|TokenValue|TokenSignature)=([^&\s"]+)/gi, '$1=[redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
  for (const serial of serials) {
    if (!serial) continue;
    const hex = Buffer.from(serial).toString('hex');
    out = out.split(serial).join('[serial]').split(hex).join('[serial-hex]');
  }
  return out;
}

/** ISO-8601 UTC to whole seconds, as in the protocol notes ("2026-10-24T09:00:00Z"). */
function timestamp(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

module.exports = {
  detectModel, actionableFaults, mergeState, isDockedAndIdle, canStart, canDockAction,
  isReturning, toHomeKit, redact, timestamp, LOW_BATTERY_PERCENT,
};
