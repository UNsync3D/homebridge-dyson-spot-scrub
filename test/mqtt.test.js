'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DysonMqtt } = require('../src/dysonMqtt');

function fakeMqtt() {
  const calls = { urls: [], opts: [], subs: [], pubs: [] };
  const client = new EventEmitter();
  client.connected = true;
  client.subscribe = (t, o, cb) => { calls.subs.push(t); cb(null); };
  client.publish = (t, p, o, cb) => { calls.pubs.push([t, JSON.parse(p)]); cb(null); };
  client.end = () => { client.connected = false; };
  const connectImpl = (url, opts) => { calls.urls.push(url); calls.opts.push(opts); return client; };
  return { calls, client, connectImpl };
}
const CREDS = { endpoint: 'iot.example.com', clientId: 'CID', tokenValue: 'TV', tokenSignature: 'SIG', authorizerName: 'AUTH' };
const wait = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const f = fakeMqtt();
  const m = new DysonMqtt({ serial: 'SER-1234', prefix: 'RB05', getCredentials: async () => CREDS, connectImpl: f.connectImpl });
  m.on('error', () => {});
  await m.start();
  f.client.emit('connect');
  await wait();
  return { f, m };
}
const send = (f, topic, body) => f.client.emit('message', topic, Buffer.from(JSON.stringify(body)));

test('connects with the custom-authorizer URL, keepalive 30, own reconnect, then subscribes and asks for state', async () => {
  const { f, m } = await started();
  const url = new URL(f.calls.urls[0]);
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.pathname, '/mqtt');
  assert.equal(url.searchParams.get('x-amz-customauthorizer-name'), 'AUTH');
  assert.equal(url.searchParams.get('token'), 'TV');
  assert.equal(url.searchParams.get('x-amz-customauthorizer-signature'), 'SIG');
  assert.equal(f.calls.opts[0].clientId, 'CID');
  assert.equal(f.calls.opts[0].keepalive, 30);
  assert.equal(f.calls.opts[0].reconnectPeriod, 0);
  assert.deepEqual(f.calls.subs, ['+/SER-1234/#']);
  assert.equal(f.calls.pubs[0][0], 'RB05/SER-1234/command');
  assert.equal(f.calls.pubs[0][1].msg, 'REQUEST-CURRENT-STATE');
  assert.match(f.calls.pubs[0][1].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  m.stop();
});

test('switches prefix to the robot-reported one and ignores other serials', async () => {
  const { f, m } = await started();
  let states = 0;
  m.on('state', () => states++);
  send(f, 'OTHER/NOT-MINE/status', { msg: 'CURRENT-STATE' });
  assert.equal(states, 0);
  send(f, 'RB07/SER-1234/status', { msg: 'CURRENT-STATE', state: 'INACTIVE_CHARGING' });
  assert.equal(states, 1);
  assert.equal(m.prefix, 'RB07');
  m.stop();
});

test('GONE-AWAY marks offline, IM-BACK marks online and re-requests state', async () => {
  const { f, m } = await started();
  const online = [];
  m.on('online', (v) => online.push(v));
  send(f, 'RB05/SER-1234/status', { msg: 'GONE-AWAY' });
  const before = f.calls.pubs.length;
  send(f, 'RB05/SER-1234/status', { msg: 'IM-BACK' });
  await wait();
  assert.deepEqual(online, [false, true]);
  assert.equal(f.calls.pubs.length, before + 1);
  assert.equal(f.calls.pubs.at(-1)[1].msg, 'REQUEST-CURRENT-STATE');
  m.stop();
});

test('JDM replies are matched by msgId and other clients replies are ignored', async () => {
  const { f, m } = await started();
  const p = m.callJdm('service.get_preference', { map_id: 'M' });
  await wait();
  const [topic, body] = f.calls.pubs.at(-1);
  assert.equal(topic, 'RB05/SER-1234/command/jdm');
  assert.equal(body.version, '1.0.1');
  assert.equal(typeof body.msgId, 'number'); // numeric on the wire, like the app's
  assert.ok(Number.isInteger(body.msgId) && body.msgId > 0 && body.msgId < 2 ** 31);
  assert.ok(!('time' in body), 'JDM requests carry no time field');
  assert.equal(body.method, 'service.get_preference');
  send(f, 'RB05/SER-1234/status/jdm', { msgId: 'someone-else', code: 0, data: { nope: true } });
  send(f, 'RB05/SER-1234/status/jdm', { msgId: body.msgId, code: 0, method: 'service.get_preference', data: { map_id: 'M' } });
  assert.deepEqual(await p, { code: 0, data: { map_id: 'M' } });
  m.stop();
});

test('prop.post is forwarded; UPDATE-LOCAL-BROKER-CONFIG is never forwarded', async () => {
  const { f, m } = await started();
  const props = [];
  let states = 0;
  m.on('prop', (p) => props.push(p));
  m.on('state', () => states++);
  send(f, 'RB05/SER-1234/status/jdm', { method: 'prop.post', params: { work_mode: 32 } });
  send(f, 'RB05/SER-1234/status', { msg: 'UPDATE-LOCAL-BROKER-CONFIG', localpwd: 'secret' });
  assert.deepEqual(props, [{ work_mode: 32 }]);
  assert.equal(states, 0);
  m.stop();
});

test('a close schedules a reconnect with fresh credentials', async () => {
  let calls = 0;
  const f = fakeMqtt();
  const m = new DysonMqtt({
    serial: 'SER-1234', prefix: 'RB05', connectImpl: f.connectImpl,
    getCredentials: async () => { calls++; return CREDS; },
  });
  m.on('error', () => {});
  await m.start();
  const online = [];
  m.on('online', (v) => online.push(v));
  f.client.emit('close');
  assert.deepEqual(online, [false]);
  assert.ok(m.reconnectTimer);
  assert.equal(calls, 1);
  m.stop();
});
