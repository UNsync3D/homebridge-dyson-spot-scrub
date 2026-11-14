'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canStart, canDockAction, mergeState, toHomeKit, redact, actionableFaults, detectModel, timestamp, clearReadiness } = require('../src/robotState');

const idle = () => mergeState({}, {
  msg: 'CURRENT-STATE', state: 'INACTIVE_CHARGING', dockState: 'IDLE', batteryChargeLevel: 100,
  activeFaults: [{ faultCode: 2105, nextActionRequired: 'LOG_ONLY' }],
});

test('LOG_ONLY faults are ignored and an idle robot can start', () => {
  const s = idle();
  assert.equal(actionableFaults(s).length, 0);
  assert.ok(canStart(s, true).ok);
  assert.ok(!canStart(s, false).ok);
  assert.ok(canDockAction(s, true).ok);
});

test('position-only pushes merge instead of replacing', () => {
  const s = mergeState(idle(), { globalPosition: [{ id: 1, x: 0, y: 0 }] });
  assert.equal(s.state, 'INACTIVE_CHARGING');
});

test('a stale USER_CONTINUE fault does not block a start, but other faults do', () => {
  const stale = mergeState(idle(), { activeFaults: [{ faultCode: 581, nextActionRequired: 'USER_CONTINUE' }] });
  assert.ok(canStart(stale, true).ok);
  assert.equal(toHomeKit(stale).fault, true);
  const hard = mergeState(idle(), { activeFaults: [{ faultCode: 560, nextActionRequired: 'USER_ACTION' }] });
  assert.ok(!canStart(hard, true).ok);
});

test('drying: start allowed after aborting the dry, dock actions refused', () => {
  const drying = mergeState(idle(), { dockState: 'DRYING_MOP' });
  assert.deepEqual(canStart(drying, true), { ok: true, needsAbortDry: true });
  assert.ok(!canDockAction(drying, true).ok);
});

test('Home is not finished: ABORTED reads as returning, not cleaning', () => {
  const aborted = mergeState(idle(), { state: 'FULL_CLEAN_ABORTED' });
  assert.equal(toHomeKit(aborted).cleanOn, false);
  assert.ok(!canStart(aborted, true).ok);
  assert.equal(toHomeKit(mergeState(idle(), { state: 'FULL_CLEAN_RUNNING' })).cleanOn, true);
  assert.equal(toHomeKit(mergeState(idle(), { state: 'FULL_CLEAN_PAUSED' })).paused, true);
  assert.equal(toHomeKit(mergeState(idle(), { state: 'FULL_CLEAN_RUNNING', workMode: 38 })).cleanOn, false);
});

test('filters come from consumables, cleaning solution is excluded', () => {
  const s = mergeState(idle(), { consumables: [
    { type: 'brushBar', usage: 95 }, { type: 'robotFilter', usage: 10 }, { type: 'cleaningSolution', needsRefill: true },
  ] });
  const f = toHomeKit(s).filters;
  assert.equal(f.length, 2);
  assert.deepEqual(f.find((x) => x.type === 'brushBar'), { type: 'brushBar', lifeLevel: 5, changeNeeded: true });
});

test('model detection', () => {
  assert.equal(detectModel('804', undefined), 'spot-scrub-ai');
  assert.equal(detectModel(undefined, 'RB07'), 'r2');
  assert.equal(detectModel('999', 'RB09'), 'unknown');
});

test('redact strips tokens, localpwd, emails, serials and hex clean ids', () => {
  const serial = 'AB1-AU-ABC1234D';
  const hex = Buffer.from(serial).toString('hex');
  const out = redact(
    `serial ${serial} clean ${hex} {"localpwd":"secret"} me@x.com Bearer ${'a'.repeat(32)}-1 wss://h/mqtt?token=abc&x-amz-customauthorizer-signature=def`,
    [serial],
  );
  for (const bad of [serial, hex, 'secret', 'me@x.com', 'abc', 'def']) assert.ok(!out.includes(bad), bad);
});

test('timestamps are UTC to whole seconds', () => {
  assert.equal(timestamp(new Date('2026-10-24T09:00:00.123Z')), '2026-10-24T09:00:00Z');
  assert.match(timestamp(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('clearReadiness drops the ready fields, keeps the rest, and blocks starts until fresh state arrives', () => {
  const before = mergeState(idle(), { persistentMapId: '1', consumables: [{ type: 'brushBar', usage: 5 }], workMode: 38, jdmStatus: 4 });
  const after = clearReadiness(before);
  for (const k of ['state', 'dockState', 'workMode', 'jdmStatus']) assert.ok(!(k in after), k);
  assert.equal(after.batteryChargeLevel, 100);
  assert.equal(after.persistentMapId, '1');
  assert.equal(before.state, 'INACTIVE_CHARGING'); // input untouched
  assert.ok(!canStart(after, true).ok);
  assert.ok(canStart(mergeState(after, { state: 'INACTIVE_CHARGING', dockState: 'IDLE' }), true).ok);
});

test('older firmware reports faultId; it is treated like faultCode', () => {
  const s = mergeState({}, { state: 'INACTIVE_CHARGING', dockState: 'IDLE', activeFaults: [{ faultId: 2105 }, { faultId: 513 }] });
  assert.deepEqual(actionableFaults(s).map((f) => f.faultId), [513]);
  assert.match(canStart(s, true).reason, /513/);
});

test('DOCKED counts as docked and idle', () => {
  assert.ok(canStart(mergeState({}, { state: 'INACTIVE_CHARGED', dockState: 'DOCKED' }), true).ok);
});

test('dock actions: allowed on the dock between cleans, refused when busy, cleaning or returning', () => {
  const st = (state, dockState) => mergeState({}, { state, dockState });
  for (const state of ['INACTIVE_CHARGING', 'INACTIVE_CHARGED']) assert.ok(canDockAction(st(state, 'IDLE'), true).ok);
  for (const dock of ['COLLECTING_DUST', 'WASHING_MOP', 'DRYING_MOP']) assert.ok(!canDockAction(st('INACTIVE_CHARGING', dock), true).ok);
  for (const state of ['FULL_CLEAN_RUNNING', 'FULL_CLEAN_FINISHED', 'RETURNING_TO_BASE', 'INACTIVE_DISCHARGING']) {
    assert.ok(!canDockAction(st(state, 'IDLE'), true).ok, state);
  }
  assert.ok(!canDockAction(st('INACTIVE_CHARGING', 'IDLE'), false).ok);
});

test('RETURNING_TO_BASE reads as returning', () => {
  const { isReturning } = require('../src/robotState');
  assert.ok(isReturning({ state: 'RETURNING_TO_BASE' }));
  assert.ok(!isReturning({ state: 'FULL_CLEAN_RUNNING' }));
});
