'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RobotController, CommandRefused } = require('../src/robotController');

const ROWS = () => [
  [10, 'Hall', 0, 3, 0, 1, 0, 0, 0, 0, 1, 0],
  [11, 'Kitchen', 0, 1, 3, 0, 0, 0, 0, 0, 2, 0],
];
const READY = { state: 'INACTIVE_CHARGING', dockState: 'IDLE' };

function setup(model = 'spot-scrub-ai', state = READY) {
  const sent = [];
  const waiters = [];
  const link = {
    sendLegacy: async (m) => { sent.push(['legacy', m]); },
    callJdm: (method, params) => {
      sent.push(['jdm', method, params]);
      if (method === 'service.get_preference') return new Promise((r) => waiters.push(r));
      return Promise.resolve({ code: 0 });
    },
  };
  const c = new RobotController({ link, model, getState: () => state, isOnline: () => true });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { c, sent, waiters, tick };
}

test('room start follows the app: get_preference, set_preference, START', async () => {
  const { c, sent, waiters, tick } = setup();
  const p = c.startRooms('MAP1', [11]);
  await tick();
  waiters[0]({ data: { map_id: 'MAP1', room_preference: ROWS(), uv_switch: [[10, 0], [11, 0]] } });
  await p;
  assert.deepEqual(sent.map((x) => x[1] && x[1].msg || x[1]), ['service.get_preference', 'service.set_preference', 'START']);
  const set = sent[1][2];
  assert.equal(set.room_preference[1][8], 1);
  assert.equal(set.room_preference[1][10], 1);
  assert.equal(set.room_preference[0][8], 0);
  assert.deepEqual(set.uv_switch, [[10, 0], [11, 0]]);
  assert.deepEqual(sent[2][1].cleaningProgramme.unorderedZones, ['11']);
});

test('only one start at a time', async () => {
  const { c, waiters, tick } = setup();
  const p = c.startRooms('MAP1', null);
  await tick();
  await assert.rejects(c.startRooms('MAP1', null), CommandRefused);
  waiters[0]({ data: { map_id: 'MAP1', room_preference: ROWS() } });
  await p;
});

test('Stop during preparation cancels START', async () => {
  const { c, sent, waiters, tick } = setup();
  const p = c.startRooms('MAP1', null);
  await tick();
  await c.stop();
  waiters[0]({ data: { map_id: 'MAP1', room_preference: ROWS() } });
  await p;
  assert.ok(!sent.some((x) => x[0] === 'legacy' && x[1].msg === 'START'));
});

test('a reply for the wrong map is rejected', async () => {
  const { c, waiters, tick } = setup();
  const p = c.startRooms('MAP1', null);
  await tick();
  waiters[0]({ data: { map_id: 'OTHER', room_preference: ROWS() } });
  await assert.rejects(p, CommandRefused);
});

test('R2 rows are trimmed to 11 values', async () => {
  const { c, sent, waiters, tick } = setup('r2');
  const p = c.startRooms('MAP1', null);
  await tick();
  waiters[0]({ data: { map_id: 'MAP1', room_preference: ROWS() } });
  await p;
  assert.equal(sent.find((x) => x[1] === 'service.set_preference')[2].room_preference[0].length, 11);
});

test('a start while drying aborts the dry first', async () => {
  const { c, sent, waiters, tick } = setup('spot-scrub-ai', { ...READY, dockState: 'DRYING_MOP' });
  const p = c.startRooms('MAP1', null);
  await tick();
  waiters[0]({ data: { map_id: 'MAP1', room_preference: ROWS() } });
  await p;
  assert.deepEqual(sent[0][1], { msg: 'ABORT-DOCK-ACTION', action: 'DRY_MOP', time: sent[0][1].time });
});

test('dock actions are refused unless docked and idle, and resume is a JDM call', async () => {
  const busy = setup('spot-scrub-ai', { state: 'FULL_CLEAN_RUNNING', dockState: 'IDLE' });
  await assert.rejects(busy.c.dockAction('WASH_MOP'), CommandRefused);
  await assert.rejects(busy.c.startRooms('MAP1', null), CommandRefused);
  const ok = setup();
  await ok.c.dockAction('COLLECT_DUST');
  assert.equal(ok.sent[0][1].action, 'COLLECT_DUST');
  await ok.c.resume();
  assert.deepEqual(ok.sent[1].slice(1), ['service.set_room_clean', { ctrl_value: 1, clean_type: 0, room_ids: [] }]);
});
