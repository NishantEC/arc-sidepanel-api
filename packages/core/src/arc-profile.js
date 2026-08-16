'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectSidePanelUsage, detectOwnInPageUI } = require('./detect');

/**
 * Arc's on-disk extension profile paths, by platform. Arc follows the same
 * layout Chromium itself uses for every installed extension: the CRX is
 * always unpacked to disk to be able to run it, so this works for
 * Chrome-Web-Store-installed ("packed") extensions too, not just unpacked ones.
 */
function getArcExtensionsDir(platform = process.platform) {
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Arc', 'User Data', 'Default', 'Extensions');
  }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'Packaged', 'TheBrowserCompany.Arc', 'LocalCache', 'Local', 'Arc', 'User Data', 'Default', 'Extensions');
  }
  throw new Error(`Arc's extensions directory is not known for platform "${platform}" yet.`);
}

function resolveLocalizedName(manifest, extDir) {
  const match = /^__MSG_(.+)__$/.exec(manifest.name || '');
  if (!match) return manifest.name;
  try {
    const locale = manifest.default_locale || 'en';
    const messagesPath = path.join(extDir, '_locales', locale, 'messages.json');
    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    return (messages[match[1]] && messages[match[1]].message) || manifest.name;
  } catch {
    return manifest.name;
  }
}

/**
 * Lists every extension installed in Arc's default profile, with sidePanel
 * usage detection applied to each one.
 */
function listInstalledExtensions({ extensionsDir = getArcExtensionsDir() } = {}) {
  if (!fs.existsSync(extensionsDir)) return [];

  const results = [];
  for (const id of fs.readdirSync(extensionsDir)) {
    const idDir = path.join(extensionsDir, id);
    if (!fs.statSync(idDir).isDirectory()) continue;

    const versions = fs
      .readdirSync(idDir)
      .filter((entry) => fs.statSync(path.join(idDir, entry)).isDirectory())
      .sort();
    const version = versions.at(-1);
    if (!version) continue;

    const extDir = path.join(idDir, version);
    const manifestPath = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }

    const detection = detectSidePanelUsage(manifest);
    // Scanning content-script bundles is the expensive part, so only do it for
    // the extensions we would actually offer to patch.
    const ownUI = detection.usesSidePanel
      ? detectOwnInPageUI(extDir, manifest)
      : { likelyHasOwnPanel: false, embeddedPages: [], broadScriptBytes: 0, reasons: [] };

    results.push({
      id,
      version,
      dir: extDir,
      name: resolveLocalizedName(manifest, extDir),
      ...detection,
      ownInPageUI: ownUI,
    });
  }
  return results;
}

module.exports = { getArcExtensionsDir, listInstalledExtensions };
