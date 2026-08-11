'use strict';

const { detectSidePanelUsage } = require('./detect');
const { patchExtension, PANEL_MODES } = require('./patch');
const { getArcExtensionsDir, listInstalledExtensions } = require('./arc-profile');

module.exports = {
  detectSidePanelUsage,
  patchExtension,
  PANEL_MODES,
  getArcExtensionsDir,
  listInstalledExtensions,
};
