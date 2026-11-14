'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DysonApi, DysonApiError, isSafeSerial } = require('../src/dysonApi');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace('https://appapi.cp.dyson.com', '')}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, text: async () => 'nope' };
    return { ok: r.status === undefined || r.status < 400, status: r.status || 200, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { impl, calls };
}

test('login flow hits the documented endpoints and keeps the token', async () => {
  const f = fakeFetch({
    'GET /v1/provisioningservice/application/ios/version': { body: {} },
    'POST /v3/userregistration/email/userstatus?country=AU': { body: {} },
    'POST /v3/userregistration/email/auth?country=AU&culture=en-AU': { body: { challengeId: 'CH1' } },
    'POST /v3/userregistration/email/verify?country=AU': { body: { token: 'abc-1', account: 'acc' } },
  });
  const api = new DysonApi({ country: 'au', fetchImpl: f.impl });
  await api.appVersion();
  await api.userStatus('me@x.com');
  assert.equal(await api.startLogin('me@x.com'), 'CH1');
  assert.equal(await api.verifyLogin({ email: 'me@x.com', password: 'pw', challengeId: 'CH1', otpCode: '123456' }), 'abc-1');
  assert.equal(api.token, 'abc-1');
  const verify = f.calls.at(-1);
  assert.deepEqual(JSON.parse(verify.init.body), { email: 'me@x.com', password: 'pw', challengeId: 'CH1', otpCode: '123456' });
  assert.equal(verify.init.headers['X-Platform'], 'ios');
  assert.match(verify.init.headers['User-Agent'], /^DysonLink\//);
  assert.equal(verify.init.headers.Authorization, undefined);
});

test('authenticated calls send the bearer token; robots() keeps only supported, safe serials', async () => {
  const f = fakeFetch({
    'GET /v2/provisioningservice/manifest': { body: [
      { Serial: 'AAA-AU-1234', Name: 'Mine', ProductType: '804', Version: '1', mqttRootTopicLevel: 'RB05' },
      { Serial: 'BBB-AU-5678', Name: 'Fan', ProductType: '438', Version: '1', mqttRootTopicLevel: '438' },
      { Serial: 'bad/../serial', Name: 'Evil', ProductType: '804', Version: '1', mqttRootTopicLevel: 'RB05' },
      { Serial: 'CCC-AU-9999', Name: 'R2', ProductType: 914, Version: '1', mqttRootTopicLevel: 'RB07' },
    ] },
  });
  const api = new DysonApi({ country: 'AU', token: 'tok-1', fetchImpl: f.impl });
  const robots = await api.robots();
  assert.deepEqual(robots.map((r) => [r.serial, r.prefix]), [['AAA-AU-1234', 'RB05'], ['CCC-AU-9999', 'RB07']]);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok-1');
});

test('iotCredentials maps the response and rejects unsafe serials', async () => {
  const f = fakeFetch({
    'POST /v2/authorize/iot-credentials': { body: { Endpoint: 'iot.example.com', IoTCredentials: {
      ClientId: 'CID', TokenValue: 'TV', TokenSignature: 'SIG', CustomAuthorizerName: 'AUTH' } } },
  });
  const api = new DysonApi({ country: 'AU', token: 't', fetchImpl: f.impl });
  assert.deepEqual(await api.iotCredentials('AAA-AU-1234'), {
    endpoint: 'iot.example.com', clientId: 'CID', tokenValue: 'TV', tokenSignature: 'SIG', authorizerName: 'AUTH',
  });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { Serial: 'AAA-AU-1234' });
  await assert.rejects(api.iotCredentials('x/../y'), DysonApiError);
});

test('errors carry the status but not the response body; no token means 401 before any request', async () => {
  const f = fakeFetch({ 'GET /v2/provisioningservice/manifest': { status: 401, body: { secret: 'leak' } } });
  const api = new DysonApi({ country: 'AU', token: 't', fetchImpl: f.impl });
  await assert.rejects(api.robots(), (e) => e.status === 401 && !e.message.includes('leak'));
  const none = new DysonApi({ country: 'AU', fetchImpl: f.impl });
  const before = f.calls.length;
  await assert.rejects(none.robots(), (e) => e.status === 401);
  assert.equal(f.calls.length, before);
});

test('country and serial validation', () => {
  assert.throws(() => new DysonApi({ country: 'AUS' }), DysonApiError);
  assert.ok(isSafeSerial('AB1-AU-ABC1234D'));
  for (const bad of ['', 'a#b', 'a/b', '../x', 'a+b', 'ab']) assert.ok(!isSafeSerial(bad), bad);
});
