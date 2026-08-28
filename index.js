'use strict';

const { DysonPlatform } = require('./src/platform');

const PLUGIN_NAME   = 'homebridge-dyson-robot';
const PLATFORM_NAME = 'DysonRobot';

/**
 * Homebridge entry point. Register the platform so Homebridge discovers it.
 */
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DysonPlatform);
};
