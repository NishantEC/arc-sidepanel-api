'use strict';

const fs = require('fs');
const path = require('path');

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

const PANEL_PAGE_PATTERN = /(side[-_]?panel|sidepanel|sidebar)/i;

// Reading a whole content script is the point, but some ship enormous bundles
// (Sider's is 15MB across two files). Cap it so scanning a profile full of
// extensions stays quick.
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
// A content script that builds a shadow root and is this large is rendering a
// real UI surface into every page, not decorating one. Calibrated against the
// two shapes seen in the wild: Claude's in-page agent indicator also uses a
// shadow root but is 18KB, while CSS Peeper's inspector panel is 1.6MB and
// Sider's sidebar is 9MB. Two orders of magnitude apart, so the exact cut-off
// is not load-bearing.
const SHADOW_UI_BYTES = 300 * 1024;

function isBroadMatch(pattern) {
  return pattern === '<all_urls>' || /^(\*|https?):\/\/\*\/\*/.test(pattern);
}

/**
 * Reports whether an extension already renders its own panel UI inside the
 * page, the way Sider does. Those extensions work in Arc untouched - they never
 * needed chrome.sidePanel for that surface - so patching them is usually
 * pointless and swaps a maintained UI for ours.
 *
 * There are two ways extensions do this, and both need catching:
 *
 *   1. Embedding one of their own .html pages in an iframe (Sider). Detected by
 *      a page-wide content script naming a panel-shaped page the extension
 *      actually ships.
 *   2. Rendering the UI directly in JS, with no page at all (CSS Peeper).
 *      Nothing to name, so detected by a page-wide content script that builds a
 *      shadow root and is far too large to be doing anything else.
 *
 * Deliberately ignores web_accessible_resources: patching adds the panel page
 * there, so a patched copy would flag itself.
 *
 * This is a heuristic over minified bundles. It is advisory, never a reason to
 * refuse to patch.
 */
function detectOwnInPageUI(extensionDir, manifest) {
  const embeddedPages = new Set();
  const reasons = [];
  let broadScriptBytes = 0;
  let readBytes = 0;
  let shadowUi = null;

  for (const contentScript of manifest.content_scripts || []) {
    if (!(contentScript.matches || []).some(isBroadMatch)) continue;

    for (const relative of contentScript.js || []) {
      const file = path.join(extensionDir, relative);
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      broadScriptBytes += size;
      if (size > MAX_FILE_BYTES || readBytes + size > MAX_TOTAL_BYTES) continue;

      let source;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      readBytes += size;

      if (source.includes('attachShadow') && size > (shadowUi ? shadowUi.bytes : 0)) {
        shadowUi = { file: relative, bytes: size };
      }

      for (const match of source.matchAll(/["'`]([\w\-./]+\.html)["'`]/g)) {
        const page = match[1].replace(/^\//, '');
        // Only count pages the extension actually ships - a bare "index.html"
        // in a bundle is as likely to be someone else's URL.
        if (fs.existsSync(path.join(extensionDir, page))) embeddedPages.add(page);
      }
    }
  }

  const panelPages = [...embeddedPages].filter((page) => PANEL_PAGE_PATTERN.test(page));
  if (panelPages.length) {
    reasons.push(`a content script running on every page embeds ${panelPages.join(', ')}`);
  }

  const rendersShadowUi = Boolean(shadowUi && shadowUi.bytes >= SHADOW_UI_BYTES);
  if (rendersShadowUi) {
    reasons.push(
      `it renders ${(shadowUi.bytes / 1024 / 1024).toFixed(1)}MB of shadow-DOM UI into every ` +
        `page from ${shadowUi.file}`
    );
  }

  return {
    likelyHasOwnPanel: panelPages.length > 0 || rendersShadowUi,
    embeddedPages: [...embeddedPages],
    shadowUiBytes: shadowUi ? shadowUi.bytes : 0,
    broadScriptBytes,
    reasons,
  };
}

module.exports = { detectSidePanelUsage, detectOwnInPageUI };
