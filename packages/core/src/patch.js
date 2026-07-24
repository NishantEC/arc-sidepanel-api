'use strict';

const fs = require('fs');
const path = require('path');
const { detectSidePanelUsage } = require('./detect');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const POLYFILL_DIR = '_arc_polyfill';

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest.json found at ${extensionDir}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function copyExtension(sourceDir, outputDir) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(sourceDir, outputDir, {
    recursive: true,
    filter: (src) => !/[/\\](_metadata|\.git)(?:[/\\]|$)/.test(src),
  });
}

function installPolyfillFiles(outputDir) {
  const dest = path.join(outputDir, POLYFILL_DIR);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['floating-panel.js', 'sw-shim.js']) {
    fs.copyFileSync(path.join(TEMPLATES_DIR, file), path.join(dest, file));
  }
}

/**
 * Points background.service_worker at a small wrapper that imports the shim
 * before the extension's own (untouched) service worker code. This works
 * regardless of how the original code is bundled/minified, since we never
 * edit it.
 */
function patchBackground(manifest, outputDir) {
  const background = manifest.background;
  if (!background || !background.service_worker) {
    throw new Error(
      'This extension has no background.service_worker. Only MV3 extensions that drive ' +
        'chrome.sidePanel from a background service worker are supported right now.'
    );
  }

  const isModule = background.type === 'module';
  const originalRelativePath = `../${background.service_worker}`;
  const entryRelativePath = `${POLYFILL_DIR}/service-worker-entry.js`;
  const entryContent = isModule
    ? `import './sw-shim.js';\nimport '${originalRelativePath}';\n`
    : `importScripts('sw-shim.js', '${originalRelativePath}');\n`;

  fs.writeFileSync(path.join(outputDir, entryRelativePath), entryContent, 'utf8');
  background.service_worker = entryRelativePath;
}

function patchContentScripts(manifest) {
  manifest.content_scripts = manifest.content_scripts || [];
  manifest.content_scripts.push({
    matches: ['<all_urls>'],
    js: [`${POLYFILL_DIR}/floating-panel.js`],
    run_at: 'document_idle',
  });
}

function patchCommands(manifest) {
  manifest.commands = manifest.commands || {};
  if (!manifest.commands['toggle-arc-sidepanel']) {
    manifest.commands['toggle-arc-sidepanel'] = {
      suggested_key: { default: 'Ctrl+E', mac: 'Command+E' },
      description: 'Toggle the Arc-patched side panel',
    };
  }
}

/**
 * Patches an unpacked MV3 extension directory so its chrome.sidePanel calls
 * work in Arc via a floating docked panel. Writes the patched copy to
 * outputDir and never modifies sourceDir.
 */
function patchExtension({ sourceDir, outputDir }) {
  if (!sourceDir || !outputDir) {
    throw new Error('patchExtension requires both sourceDir and outputDir');
  }

  const manifest = readManifest(sourceDir);
  if (manifest.manifest_version !== 3) {
    throw new Error(`Only Manifest V3 extensions are supported (found manifest_version ${manifest.manifest_version}).`);
  }

  const detection = detectSidePanelUsage(manifest);
  if (!detection.usesSidePanel) {
    throw new Error(
      'This extension does not appear to use chrome.sidePanel (no side_panel.default_path ' +
        'or "sidePanel" permission found in its manifest) - nothing to patch.'
    );
  }

  copyExtension(sourceDir, outputDir);
  installPolyfillFiles(outputDir);
  patchBackground(manifest, outputDir);
  patchContentScripts(manifest);
  patchCommands(manifest);
  manifest.version_name = `${manifest.version} (arc-patched)`;

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return { outputDir, manifest, detection };
}

module.exports = { patchExtension };
