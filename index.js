'use strict';

const { DysonPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('./src/platform');

/** Homebridge entry point. PLATFORM_NAME stays "DysonRobot" so existing config.json files keep working. */
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DysonPlatform);
};
