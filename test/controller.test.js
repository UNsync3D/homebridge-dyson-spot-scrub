'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RobotController, CommandRefused } = require('../src/robotController');

const ROWS = () => [
  [10, 'Hall', 0, 3, 0, 1, 0, 0, 0, 0, 1, 0],
  [11, 'Kitchen', 0, 1, 3, 0, 0, 0, 0, 0, 2, 0],
];
const READY = { state: 'INACTIVE_CHARGING', dockState: 'IDLE' };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const kind = (x) => (x[0] === 'jdm' ? x[1] : x[1].msg);

function setup(model = 'spot-scrub-ai', state = READY, saveCode = 0) {
  const sent = [];
  const waiters = [];
  const link = {
    sendLegacy: async (m) => { sent.push(['legacy', m]); },
    callJdm: (method, params) => {
      sent.push(['jdm', method, params]);
      if (method === 'service.get_preference') return new Promise((r) => waiters.push(r));
      return Promise.resolve({ code: method === 'service.set_preference' ? saveCode : 0 });
    },
  };
  const c = new RobotController({ link, model, getState: () => state, isOnline: () => true });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const reply = (data, code = 0) => waiters.shift()({ code, data });
  return { c, sent, tick, reply };
}

test('room start follows the app: get_preference, set_preference (code 0), then only START', async () => {
  const { c, sent, tick, reply } = setup();
  const p = c.startRooms('1', [11]);
  await tick();
  reply({ room: ROWS(), uv_switch: [[10, 0], [11, 0]] });
  await p;
  assert.deepEqual(sent.map(kind), ['service.get_preference', 'service.set_preference', 'START']);
  assert.deepEqual(sent[0][2], { map_id: 1 }); // the map id is a number in JDM params
  const set = sent[1][2];
  assert.equal(set.map_id, 1);
  assert.equal(set.prefer_type, 1);
  assert.equal(set.room_preference[1][8], 1);  // Kitchen selected
  assert.equal(set.room_preference[0][8], 0);  // Hall not
  assert.equal(set.room_preference[0][10], 1); // saved order untouched
  assert.equal(set.room_preference[1][10], 2);
  assert.deepEqual(set.uv_switch, [[10, 0], [11, 0]]);
  const { time, ...start } = sent[2][1];
  assert.deepEqual(start, {
    msg: 'START', 'mode-reason': 'RAPP', cleaningMode: 'zoneConfigured',
    cleaningProgramme: { persistentMapId: '1', unorderedZones: ['11'] },
  });
  assert.match(time, ISO);
});

test('whole home selects every room', async () => {
  const { c, sent, tick, reply } = setup();
  const p = c.startWholeHome('1');
  await tick();
  reply({ room: ROWS() });
  await p;
  assert.deepEqual(sent[1][2].room_preference.map((r) => r[8]), [1, 1]);
  assert.deepEqual(sent[2][1].cleaningProgramme.unorderedZones, ['10', '11']);
});

test('the map must be known and numeric', async () => {
  const { c } = setup();
  for (const bad of [undefined, null, '', 'abc']) await assert.rejects(c.startRooms(bad, null), CommandRefused);
});

test('only one start at a time', async () => {
  const { c, tick, reply } = setup();
  const p = c.startRooms('1', null);
  await tick();
  await assert.rejects(c.startRooms('1', null), CommandRefused);
  reply({ room: ROWS() });
  await p;
});

test('Home or Pause during preparation cancels START', async () => {
  for (const cancel of ['home', 'pause']) {
    const { c, sent, tick, reply } = setup();
    const p = c.startRooms('1', null);
    await tick();
    await c[cancel]();
    reply({ room: ROWS() });
    await p;
    assert.ok(!sent.some((x) => x[0] === 'legacy' && x[1].msg === 'START'), cancel);
    assert.ok(!sent.some((x) => x[1] === 'service.set_preference'), cancel);
  }
});

test('a reply for another map is refused; map_id is optional and may be a string', async () => {
  const wrong = setup();
  let p = wrong.c.startRooms('1', null);
  await wrong.tick();
  wrong.reply({ map_id: 2, room: ROWS() });
  await assert.rejects(p, CommandRefused);

  const same = setup();
  p = same.c.startRooms('1', null);
  await same.tick();
  same.reply({ map_id: '1', room: ROWS() });
  await p;
  assert.equal(same.sent.at(-1)[1].msg, 'START');
});

test('incomplete replies are refused: no rooms, wrong key, short rows, error code', async () => {
  for (const [data, code] of [
    [{ room: [] }, 0], [{ room_preference: ROWS() }, 0], [{ room: [[10, 'Hall', 0]] }, 0], [{ room: ROWS() }, 1],
  ]) {
    const { c, sent, tick, reply } = setup();
    const p = c.startRooms('1', null);
    await tick();
    reply(data, code);
    await assert.rejects(p, CommandRefused);
    assert.ok(!sent.some((x) => x[1] === 'service.set_preference'));
  }
});

test('an unknown or repeated room is refused', async () => {
  for (const ids of [[99], [10, 10]]) {
    const { c, tick, reply } = setup();
    const p = c.startRooms('1', ids);
    await tick();
    reply({ room: ROWS() });
    await assert.rejects(p, CommandRefused);
  }
});

test('a partial reply is merged with rooms seen before, and set_preference carries the full list', async () => {
  const { c, sent, tick, reply } = setup();
  let p = c.startRooms('1', null);
  await tick();
  reply({ room: ROWS() });
  await p;
  sent.length = 0;

  const kitchenChanged = ROWS()[1];
  kitchenChanged[3] = 2; // changed in the app since
  p = c.startRooms('1', [10]);
  await tick();
  reply({ room: [kitchenChanged] }); // e.g. only the scheduled room
  await p;
  const rows = sent.find((x) => x[1] === 'service.set_preference')[2].room_preference;
  assert.deepEqual(rows.map((r) => r[0]), [10, 11]);
  assert.equal(rows[1][3], 2);                       // newest reply wins for the room it contains
  assert.deepEqual(rows.map((r) => r[8]), [1, 0]);
  assert.deepEqual(sent.at(-1)[1].cleaningProgramme.unorderedZones, ['10']);
});

test('R2 rows are sent with 11 values (the robot reports a 12th)', async () => {
  const { c, sent, tick, reply } = setup('r2');
  const p = c.startRooms('1', null);
  await tick();
  reply({ room: ROWS() });
  await p;
  assert.equal(sent[1][2].room_preference[0].length, 11);
  const other = setup('spot-scrub-ai');
  const q = other.c.startRooms('1', null);
  await other.tick();
  other.reply({ room: ROWS() });
  await q;
  assert.equal(other.sent[1][2].room_preference[0].length, 12);
});

test('START is not sent unless the robot confirms the settings with code 0', async () => {
  const { c, sent, tick, reply } = setup('spot-scrub-ai', READY, 5);
  const p = c.startRooms('1', null);
  await tick();
  reply({ room: ROWS() });
  await assert.rejects(p, CommandRefused);
  assert.ok(!sent.some((x) => x[0] === 'legacy'));
});

test('a start while drying stops the dry after the settings are confirmed, just before START', async () => {
  const { c, sent, tick, reply } = setup('spot-scrub-ai', { ...READY, dockState: 'DRYING_MOP' });
  const p = c.startRooms('1', null);
  await tick();
  reply({ room: ROWS() });
  await p;
  assert.deepEqual(sent.map(kind), ['service.get_preference', 'service.set_preference', 'ABORT-DOCK-ACTION', 'START']);
  const { time, ...abort } = sent[2][1];
  assert.deepEqual(abort, { msg: 'ABORT-DOCK-ACTION', action: 'DRY_MOP', 'mode-reason': 'RAPP' });
  assert.match(time, ISO);
});

test('cancelPendingStart drops a start still being prepared', async () => {
  const { c, sent, tick, reply } = setup();
  const p = c.startRooms('1', null);
  await tick();
  c.cancelPendingStart();
  reply({ room: ROWS() });
  await p;
  assert.ok(!sent.some((x) => x[1] === 'service.set_preference' || (x[0] === 'legacy' && x[1].msg === 'START')));
});

test('readiness is checked again after waiting', async () => {
  let state = READY;
  const sent = [];
  let release;
  const link = {
    sendLegacy: async (m) => { sent.push(m); },
    callJdm: (method) => (method === 'service.get_preference'
      ? new Promise((r) => { release = r; }) : Promise.resolve({ code: 0 })),
  };
  const c = new RobotController({ link, model: 'spot-scrub-ai', getState: () => state, isOnline: () => true });
  const p = c.startRooms('1', null);
  await new Promise((r) => setTimeout(r, 0));
  state = { state: 'FULL_CLEAN_RUNNING', dockState: 'IDLE' }; // the app started a clean meanwhile
  release({ code: 0, data: { room: ROWS() } });
  await assert.rejects(p, CommandRefused);
  assert.equal(sent.length, 0);
});

test('dock actions need a docked, idle robot; resume, pause, home and stop send the documented messages', async () => {
  const busy = setup('spot-scrub-ai', { state: 'FULL_CLEAN_RUNNING', dockState: 'IDLE' });
  await assert.rejects(busy.c.dockAction('WASH_MOP'), CommandRefused);
  await assert.rejects(busy.c.startRooms('1', null), CommandRefused);

  const ok = setup();
  await ok.c.dockAction('COLLECT_DUST');
  assert.equal(ok.sent[0][1].action, 'COLLECT_DUST');
  await ok.c.resume();
  assert.deepEqual(ok.sent[1].slice(1), ['service.set_room_clean', { ctrl_value: 1, clean_type: 0, room_ids: [] }]);
  await ok.c.pause();
  await ok.c.home();
  await ok.c.stop();
  assert.deepEqual(ok.sent.slice(2).map((x) => x[1].msg), ['PAUSE', 'ABORT', 'STOP']);
});
