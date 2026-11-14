'use strict';
/**
 * dysonMqtt.js: AWS IoT Core over WebSocket TLS (port 443), keepalive 30 s.
 *
 *   wss://<Endpoint>/mqtt?x-amz-customauthorizer-name=...&token=...&x-amz-customauthorizer-signature=...
 *
 * Use the ClientId Dyson returns: two connections with the same ID kick each other off.
 * Topics: <prefix>/<serial>/{command, status, command/jdm, status/jdm, status/jdm/map}.
 * Every client logged in to the account sees every other client's messages, so ignore what you didn't ask for.
 *
 * Events: 'online' (bool), 'state' (legacy status payload), 'prop' (JDM prop.post data), 'error' (Error).
 */
const { EventEmitter } = require('node:events');
const { randomInt } = require('node:crypto');
const { timestamp } = require('./robotState');

const KEEPALIVE_SECONDS = 30;
const JDM_TIMEOUT_MS = 15000;
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 60000;

class DysonMqtt extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.serial
   * @param {string} o.prefix           from the manifest; switched if the robot reports another
   * @param {() => Promise<object>} o.getCredentials   returns fresh IoT credentials (they are short-lived)
   * @param {Function} [o.connectImpl]  mqtt.connect, injectable for tests
   */
  constructor({ serial, prefix, getCredentials, connectImpl, logger }) {
    super();
    this.serial = serial;
    this.prefix = prefix;
    this.getCredentials = getCredentials;
    this.connectImpl = connectImpl || require('mqtt').connect;
    this.log = logger || { debug() {}, warn() {} };
    this.client = null;
    this.pending = new Map();
    this.stopped = false;
    this.backoff = BACKOFF_START_MS;
    this.reconnectTimer = null;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    if (this.client) this.client.end(true);
    this.client = null;
  }

  async connect() {
    let creds;
    try {
      creds = await this.getCredentials();
    } catch (e) {
      this.emit('error', e);
      return this.scheduleReconnect();
    }
    const q = new URLSearchParams({
      'x-amz-customauthorizer-name': creds.authorizerName,
      token: creds.tokenValue,
      'x-amz-customauthorizer-signature': creds.tokenSignature,
    });
    const url = `wss://${creds.endpoint}/mqtt?${q.toString()}`;

    const client = this.connectImpl(url, {
      clientId: creds.clientId,
      keepalive: KEEPALIVE_SECONDS,
      reconnectPeriod: 0, // credentials expire, so reconnect ourselves with fresh ones
      clean: true,
    });
    this.client = client;

    client.on('connect', () => {
      this.backoff = BACKOFF_START_MS;
      client.subscribe(`+/${this.serial}/#`, { qos: 0 }, (err) => {
        if (err) return this.emit('error', err);
        this.requestState().catch((e) => this.emit('error', e));
      });
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    client.on('error', (e) => this.emit('error', e));
    client.on('close', () => {
      if (this.client === client) {
        this.emit('online', false);
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  // ---- inbound --------------------------------------------------------------------------------

  onMessage(topic, payload) {
    const parts = topic.split('/');
    if (parts.length < 3 || parts[1] !== this.serial) return;
    if (parts[0] !== this.prefix) {
      this.log.debug('MQTT prefix switched to the robot-reported one');
      this.prefix = parts[0];
    }
    const kind = parts.slice(2).join('/');

    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return;
    }

    if (kind === 'status') return this.onStatus(msg);
    if (kind === 'status/jdm') return this.onJdm(msg);
    // status/jdm/map ("Processing success" after a map edit) and our own command topics: ignore
  }

  onStatus(msg) {
    switch (msg.msg) {
      case 'CURRENT-STATE':
      case 'STATE-CHANGE':
        this.emit('online', true);
        this.emit('state', msg);
        break;
      case 'HELLO':
      case 'IM-BACK':
        // Not proof the robot is reachable with a current state: its CURRENT-STATE reply marks it online.
        this.requestState().catch((e) => this.emit('error', e));
        break;
      case 'GONE-AWAY':
        this.emit('online', false); // keep the last state, mark unavailable
        break;
      default:
        // MAP-UPLOAD-STATUS and UPDATE-LOCAL-BROKER-CONFIG (holds localpwd) are deliberately not logged or forwarded.
        break;
    }
  }

  onJdm(msg) {
    if (msg.method === 'prop.post') {
      this.emit('prop', msg.params || msg.data || {}); // properties sit under `params` per the protocol notes
      return;
    }
    if (msg.msgId === undefined) return;
    const p = this.pending.get(String(msg.msgId));
    if (!p) return; // someone else's reply
    clearTimeout(p.timer);
    this.pending.delete(String(msg.msgId));
    p.resolve({ code: msg.code, data: msg.data });
  }

  // ---- outbound -------------------------------------------------------------------------------

  publish(topicSuffix, body) {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.client.connected) return reject(new Error('Not connected'));
      this.client.publish(`${this.prefix}/${this.serial}/${topicSuffix}`, JSON.stringify(body), { qos: 0 }, (err) =>
        err ? reject(err) : resolve());
    });
  }

  /** Legacy message on /command. The cloud turns it into JDM calls, so never send both. */
  sendLegacy(msg) {
    return this.publish('command', msg);
  }

  requestState() {
    return this.sendLegacy({ msg: 'REQUEST-CURRENT-STATE', time: timestamp() });
  }

  /** A random 32-bit number as a string, the form the Home Assistant integration sends on live robots. */
  newMsgId() {
    let id;
    do { id = String(randomInt(0, 4294967296)); } while (this.pending.has(id));
    return id;
  }

  /** JDM RPC. Resolves with {code, data} from the reply matched by msgId. */
  callJdm(method, params) {
    const msgId = this.newMsgId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`No reply to ${method}`));
      }, JDM_TIMEOUT_MS);
      this.pending.set(msgId, { resolve, reject, timer });
      this.publish('command/jdm', {
        msgId,
        version: '1.0.1',
        method,
        params,
        time: timestamp(),
      }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(msgId);
        reject(e);
      });
    });
  }
}

module.exports = { DysonMqtt, KEEPALIVE_SECONDS };
