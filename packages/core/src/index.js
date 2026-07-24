'use strict';

const { detectSidePanelUsage } = require('./detect');
const { patchExtension } = require('./patch');
const { getArcExtensionsDir, listInstalledExtensions } = require('./arc-profile');

module.exports = {
  detectSidePanelUsage,
  patchExtension,
  getArcExtensionsDir,
  listInstalledExtensions,
};
