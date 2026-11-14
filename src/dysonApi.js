'use strict';
/**
 * dysonApi.js: Dyson cloud REST client (login, manifest, IoT credentials).
 * Host and headers come from the protocol notes. api.cp.dyson.com sits behind Cloudflare mutual TLS
 * and answers 403, so only appapi.cp.dyson.com is used. Port 443 only.
 */
const BASE_URL = 'https://appapi.cp.dyson.com';
const APP_HEADERS = {
  'User-Agent': 'DysonLink/242328 CFNetwork/3896.200.61 Darwin/27.2.0',
  'X-App-Version': '6.4.26420',
  'X-Platform': 'ios',
};
const SUPPORTED_PRODUCT_TYPES = new Set(['804', '914']); // Spot+Scrub AI, R2 Nurovi Wash+Dry

class DysonApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Serials end up in MQTT topics and URLs, so reject anything that could escape them (#, +, /, ..). */
function isSafeSerial(serial) {
  return typeof serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{3,40}$/.test(serial);
}

function isCountryCode(cc) {
  return typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc);
}

class DysonApi {
  constructor({ country, token, fetchImpl } = {}) {
    if (!isCountryCode(country)) throw new DysonApiError('Country must be a two-letter code, for example AU or GB');
    this.country = country.toUpperCase();
    this.token = token || null;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async request(method, path, { body, auth = true } = {}) {
    const headers = { ...APP_HEADERS, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.token) throw new DysonApiError('Not signed in. Run the auth script first.', 401);
      headers.Authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetch(BASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // A wrong password, wrong code and locked account all return the same 401. Keep error text short and body-free.
      throw new DysonApiError(`Dyson API ${method} ${path.split('?')[0]} failed with HTTP ${res.status}`, res.status);
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new DysonApiError(`Dyson API ${method} ${path.split('?')[0]} returned invalid JSON`, res.status);
    }
  }

  // ---- login (email + one-time code) ---------------------------------------------------------

  appVersion() {
    return this.request('GET', '/v1/provisioningservice/application/ios/version', { auth: false });
  }

  userStatus(email) {
    return this.request('POST', `/v3/userregistration/email/userstatus?country=${this.country}`, {
      body: { email }, auth: false,
    });
  }

  /** Dyson emails a 6-digit code. Resolves with the challengeId. */
  async startLogin(email) {
    const res = await this.request(
      'POST',
      `/v3/userregistration/email/auth?country=${this.country}&culture=en-${this.country}`,
      { body: { email }, auth: false },
    );
    if (!res.challengeId) throw new DysonApiError('Dyson did not return a challengeId');
    return res.challengeId;
  }

  /** Resolves with the bearer token. Repeated failures lock the account for a while. */
  async verifyLogin({ email, password, challengeId, otpCode }) {
    const res = await this.request('POST', `/v3/userregistration/email/verify?country=${this.country}`, {
      body: { email, password, challengeId, otpCode }, auth: false,
    });
    if (!res.token) throw new DysonApiError('Dyson did not return a token');
    this.token = res.token;
    return res.token;
  }

  // ---- devices --------------------------------------------------------------------------------

  /** Supported robots on the account, as [{serial, name, productType, version, prefix}]. */
  async robots() {
    const res = await this.request('GET', '/v2/provisioningservice/manifest');
    const list = Array.isArray(res) ? res : res.devices || res.Devices || []; // ASSUMPTION: shape, confirm
    return list
      .map((d) => ({
        serial: d.Serial,
        name: d.Name,
        productType: String(d.ProductType),
        version: d.Version,
        prefix: d.mqttRootTopicLevel,
      }))
      .filter((d) => isSafeSerial(d.serial) && SUPPORTED_PRODUCT_TYPES.has(d.productType));
  }

  /** Short-lived AWS IoT credentials for one robot. Never log the result. */
  async iotCredentials(serial) {
    if (!isSafeSerial(serial)) throw new DysonApiError('Unsafe serial');
    const res = await this.request('POST', '/v2/authorize/iot-credentials', { body: { Serial: serial } });
    const c = res.IoTCredentials || {};
    if (!res.Endpoint || !c.ClientId) throw new DysonApiError('Dyson returned incomplete IoT credentials');
    return {
      endpoint: res.Endpoint,
      clientId: c.ClientId,
      tokenValue: c.TokenValue,
      tokenSignature: c.TokenSignature,
      authorizerName: c.CustomAuthorizerName,
    };
  }
}

module.exports = { DysonApi, DysonApiError, isSafeSerial, isCountryCode, SUPPORTED_PRODUCT_TYPES };
