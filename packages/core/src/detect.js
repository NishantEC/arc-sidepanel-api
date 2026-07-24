'use strict';

/**
 * Inspects a parsed manifest.json and reports whether the extension relies
 * on chrome.sidePanel, which Arc does not implement.
 */
function detectSidePanelUsage(manifest) {
  const hasSidePanelKey = Boolean(manifest.side_panel && manifest.side_panel.default_path);
  const hasPermission = Array.isArray(manifest.permissions) && manifest.permissions.includes('sidePanel');
  const reasons = [];
  if (hasSidePanelKey) reasons.push('manifest declares side_panel.default_path');
  if (hasPermission) reasons.push('manifest declares the "sidePanel" permission');

  return {
    usesSidePanel: hasSidePanelKey || hasPermission,
    defaultPath: (manifest.side_panel && manifest.side_panel.default_path) || null,
    reasons,
  };
}

module.exports = { detectSidePanelUsage };
