'use strict';

const { detectSidePanelUsage, detectOwnInPageUI } = require('./detect');
const { patchExtension, PANEL_MODES } = require('./patch');
const { getArcExtensionsDir, listInstalledExtensions } = require('./arc-profile');

module.exports = {
  detectSidePanelUsage,
  detectOwnInPageUI,
  patchExtension,
  PANEL_MODES,
  getArcExtensionsDir,
  listInstalledExtensions,
};
