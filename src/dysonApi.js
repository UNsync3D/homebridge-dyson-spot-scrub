'use strict';
/**
 * dysonApi.js: Dyson cloud REST client (login, manifest, IoT credentials).
 * Host and headers come from the protocol notes. api.cp.dyson.com sits behind Cloudflare mutual TLS
 * and answers 403, so only appapi.cp.dyson.com is used. Port 443 only.
 */
const BASE_URL = 'https://appapi.cp.dyson.com';
// Exactly as the Home Assistant integration sends them (captured from the iOS app). Take the app version,
// build and iOS version from one fresh capture when refreshing; never mix a new version with an old User-Agent.
const APP_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'DysonLink/242328 CFNetwork/3896.200.61 Darwin/27.2.0',
  Accept: 'application/json',
  'Accept-Language': 'en-AU,en;q=0.9',
  'X-App-Version': '6.4.26420',
  'X-Platform': 'ios',
};
const LOGIN_HEADERS = { ...APP_HEADERS, 'Cache-Control': 'no-cache' }; // the app's login calls also send this
const SUPPORTED_PRODUCT_TYPES = new Set(['804', '914']); // Spot+Scrub AI, R2 Nurovi Wash+Dry
const DEFAULT_PREFIX = { 804: 'RB05', 914: 'RB07' };      // used if the manifest gives none we can trust
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;            // it goes into MQTT topics: no wildcards, no "/"
const DEFAULT_AUTHORIZER = 'cld-iot-credentials-lambda-authorizer';

class DysonApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Serials end up in MQTT topics and URLs, so reject anything that could escape them (#, +, /, ..). */
function isSafeSerial(serial) {
  return typeof serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/.test(serial);
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
    const headers = { ...(auth ? APP_HEADERS : LOGIN_HEADERS) };
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
      .map((d) => {
        const productType = String(d.ProductType ?? d.productType);
        const raw = d.mqttRootTopicLevel;
        return {
          serial: d.Serial || d.serial,
          name: d.Name || d.name,
          productType,
          version: d.Version || d.version,
          // The robot's own messages also reveal the real prefix, and the MQTT layer switches to it.
          prefix: typeof raw === 'string' && PREFIX_PATTERN.test(raw) ? raw : DEFAULT_PREFIX[productType],
        };
      })
      .filter((d) => isSafeSerial(d.serial) && SUPPORTED_PRODUCT_TYPES.has(d.productType));
  }

  /** Short-lived AWS IoT credentials for one robot. Never log the result. */
  async iotCredentials(serial) {
    if (!isSafeSerial(serial)) throw new DysonApiError('Unsafe serial');
    const res = await this.request('POST', '/v2/authorize/iot-credentials', { body: { Serial: serial } });
    const c = res.IoTCredentials || res; // field names also appear in camelCase
    const creds = {
      endpoint: res.Endpoint || res.endpoint,
      clientId: c.ClientId || c.clientId,
      tokenValue: c.TokenValue || c.tokenValue,
      tokenSignature: c.TokenSignature || c.tokenSignature,
      authorizerName: c.CustomAuthorizerName || c.authorizerName || DEFAULT_AUTHORIZER,
    };
    if (!creds.endpoint || !creds.clientId || !creds.tokenValue || !creds.tokenSignature) {
      throw new DysonApiError('Dyson returned incomplete IoT credentials');
    }
    return creds;
  }

  /** The account's saved maps: [{id, name, isCurrentMap, zones: [{id, name, ...}]}]. */
  async mapMetadata(serial) {
    if (!isSafeSerial(serial)) throw new DysonApiError('Unsafe serial');
    const res = await this.request('GET', `/v2/app/${encodeURIComponent(serial)}/persistent-map-metadata`);
    if (!Array.isArray(res)) throw new DysonApiError('Dyson returned unexpected map metadata');
    return res;
  }

  /**
   * The rooms Dyson says exist on one map, as Map(room id -> name), or null if that map isn't listed.
   * This is the authoritative list: get_preference replies can be partial.
   */
  async roomInventory(serial, mapId) {
    const map = (await this.mapMetadata(serial)).find((m) => String(m.id) === String(mapId));
    if (!map || !Array.isArray(map.zones)) return null;
    return new Map(map.zones.filter((z) => z && z.id !== undefined).map((z) => [String(z.id), String(z.name ?? '')]));
  }
}

module.exports = { DysonApi, DysonApiError, isSafeSerial, isCountryCode, SUPPORTED_PRODUCT_TYPES };
