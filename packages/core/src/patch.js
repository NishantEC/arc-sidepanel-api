'use strict';

const fs = require('fs');
const path = require('path');
const { detectSidePanelUsage } = require('./detect');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
// Must not start with "_" - Chromium's "Load Unpacked" refuses any unpacked
// extension containing a top-level file or directory with a leading
// underscore (those names are reserved for the system/CRX metadata).
const POLYFILL_DIR = 'arc_polyfill';
const FLOATING_PANEL_FILE = `${POLYFILL_DIR}/floating-panel.js`;
const PANEL_TABS_PATCH_FILE = `${POLYFILL_DIR}/panel-tabs-patch.js`;

const PANEL_MODES = ['overlay', 'split-tab'];

// Filenames that look like a side panel page, used when the manifest gives no
// side_panel.default_path (Chrome lets an extension supply the path purely at
// runtime through sidePanel.setOptions, which we cannot read statically).
const PANEL_PAGE_PATTERN = /(side[-_]?panel|sidepanel|panel|sidebar)/i;

// Chrome ignores a suggested_key that collides with one the extension already
// declares, so the added command has to claim a free chord or none at all.
const CANDIDATE_KEYS = [
  { default: 'Ctrl+E', mac: 'Command+E' },
  { default: 'Ctrl+Shift+E', mac: 'Command+Shift+E' },
  { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
  { default: 'Ctrl+Shift+U', mac: 'Command+Shift+U' },
];

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

function installPolyfillFiles(outputDir, { panelMode, includeTabGroupsShim }) {
  const dest = path.join(outputDir, POLYFILL_DIR);
  fs.mkdirSync(dest, { recursive: true });

  const files = ['sw-shim.js'];
  files.push(panelMode === 'split-tab' ? 'panel-tabs-patch.js' : 'floating-panel.js');
  if (includeTabGroupsShim) files.push('tabgroups-shim.js');

  for (const file of files) {
    fs.copyFileSync(path.join(TEMPLATES_DIR, file), path.join(dest, file));
  }
}

/**
 * Locates the extension's side panel page(s). Needed in both modes: overlay
 * has to expose the page through web_accessible_resources, and split-tab has
 * to inject a script into it.
 */
function findSidePanelPages(sourceDir, detection) {
  const pages = new Set();
  if (detection.defaultPath) {
    pages.add(detection.defaultPath.replace(/^\//, '').split(/[?#]/)[0]);
  }

  const rootHtml = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name);

  for (const name of rootHtml) {
    if (PANEL_PAGE_PATTERN.test(name)) pages.add(name);
  }

  // No name matched, so we cannot tell which page setOptions will ask for.
  // Fall back to every top-level page rather than shipping a patch that
  // silently renders nothing.
  if (pages.size === 0) for (const name of rootHtml) pages.add(name);

  return [...pages];
}

/**
 * The overlay's title bar shows the extension's own icon. That image is loaded
 * by the host page like any other page resource, so it needs exposing too - an
 * icon declared only in the manifest renders as a broken image.
 */
function findIconPaths(manifest) {
  const paths = new Set();
  for (const source of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (!source) continue;
    if (typeof source === 'string') {
      paths.add(source.replace(/^\//, ''));
      continue;
    }
    for (const value of Object.values(source)) {
      if (typeof value === 'string') paths.add(value.replace(/^\//, ''));
    }
  }
  return [...paths];
}

/**
 * The overlay panel renders the side panel page in an iframe on the host page,
 * so that page has to be listed in web_accessible_resources or the browser
 * blocks the load. Extensions that only ever showed the page in the native side
 * panel have no reason to declare it, so this is nearly always missing.
 */
function patchWebAccessibleResources(manifest, pages) {
  manifest.web_accessible_resources = manifest.web_accessible_resources || [];

  const alreadyExposed = new Set();
  for (const entry of manifest.web_accessible_resources) {
    if (!entry || !Array.isArray(entry.resources) || !Array.isArray(entry.matches)) continue;
    if (!entry.matches.includes('<all_urls>')) continue;
    for (const resource of entry.resources) alreadyExposed.add(resource);
  }

  const added = pages.filter((page) => !alreadyExposed.has(page));
  if (added.length) {
    manifest.web_accessible_resources.push({ resources: added, matches: ['<all_urls>'] });
  }
  return added;
}

/**
 * split-tab mode only. The panel page runs as its own tab there, so it needs
 * panel-tabs-patch.js loaded before its bundle to keep resolving the tab the
 * user is actually looking at.
 */
function injectPanelTabsPatch(outputDir, pages) {
  const tag = `<script src="/${PANEL_TABS_PATCH_FILE}"></script>`;
  const patched = [];

  for (const page of pages) {
    const file = path.join(outputDir, page);
    if (!fs.existsSync(file)) continue;

    let html = fs.readFileSync(file, 'utf8');
    if (html.includes(PANEL_TABS_PATCH_FILE)) {
      patched.push(page);
      continue;
    }

    // A classic script runs before a deferred module bundle wherever it sits,
    // but anchor on the first <script> anyway so it also precedes any inline
    // setup the page does. Fall back through progressively looser anchors so a
    // minimal or unusual page still gets patched.
    const before = html.search(/<script|<\/head>|<body[\s>]/i);
    if (before !== -1) {
      html = `${html.slice(0, before)}${tag}\n    ${html.slice(before)}`;
    } else {
      const openingHtml = /<html[^>]*>/i.exec(html);
      html = openingHtml
        ? html.slice(0, openingHtml.index + openingHtml[0].length) +
          `\n    ${tag}` +
          html.slice(openingHtml.index + openingHtml[0].length)
        : `${tag}\n${html}`;
    }

    fs.writeFileSync(file, html, 'utf8');
    patched.push(page);
  }

  if (patched.length === 0) {
    throw new Error(
      'split-tab mode needs to inject a script into the extension\'s side panel page, but none ' +
        `of the candidate pages (${pages.join(', ') || 'none found'}) could be patched. ` +
        'Try overlay mode instead.'
    );
  }
  return patched;
}

/**
 * Points background.service_worker at a small wrapper that imports the shims
 * before the extension's own (untouched) service worker code. This works
 * regardless of how the original code is bundled/minified, since we never
 * edit it.
 */
function patchBackground(manifest, outputDir, { panelMode, defaultPath, includeTabGroupsShim }) {
  const background = manifest.background;
  if (!background || !background.service_worker) {
    throw new Error(
      'This extension has no background.service_worker. Only MV3 extensions that drive ' +
        'chrome.sidePanel from a background service worker are supported right now.'
    );
  }

  // Values the shims read at runtime. Kept in its own module so that ES module
  // hoisting cannot run the shims before these are set.
  fs.writeFileSync(
    path.join(outputDir, POLYFILL_DIR, 'config.js'),
    `globalThis.__ARC_SIDEPANEL_MODE = ${JSON.stringify(panelMode)};\n` +
      `globalThis.__ARC_SIDEPANEL_DEFAULT_PATH = ${JSON.stringify(defaultPath || null)};\n` +
      `globalThis.__ARC_FLOATING_PANEL_FILE = ${JSON.stringify(FLOATING_PANEL_FILE)};\n`,
    'utf8'
  );

  const shims = ['config.js', 'sw-shim.js'];
  if (includeTabGroupsShim) shims.push('tabgroups-shim.js');

  const isModule = background.type === 'module';
  const originalRelativePath = `../${background.service_worker}`;
  const entryRelativePath = `${POLYFILL_DIR}/service-worker-entry.js`;
  const entryContent = isModule
    ? [...shims.map((f) => `import './${f}';`), `import '${originalRelativePath}';`].join('\n') + '\n'
    : `importScripts(${[...shims, originalRelativePath].map((f) => `'${f}'`).join(', ')});\n`;

  fs.writeFileSync(path.join(outputDir, entryRelativePath), entryContent, 'utf8');
  background.service_worker = entryRelativePath;
}

function patchContentScripts(manifest) {
  manifest.content_scripts = manifest.content_scripts || [];
  if (manifest.content_scripts.some((cs) => (cs.js || []).includes(FLOATING_PANEL_FILE))) return;
  manifest.content_scripts.push({
    matches: ['<all_urls>'],
    js: [FLOATING_PANEL_FILE],
    run_at: 'document_idle',
    all_frames: false,
  });
}

function patchCommands(manifest) {
  manifest.commands = manifest.commands || {};
  if (manifest.commands['toggle-arc-sidepanel']) return null;

  const taken = new Set();
  for (const command of Object.values(manifest.commands)) {
    const key = command && command.suggested_key;
    if (!key) continue;
    if (typeof key === 'string') taken.add(key);
    else for (const chord of Object.values(key)) taken.add(chord);
  }

  const free = CANDIDATE_KEYS.find((key) => !taken.has(key.default) && !taken.has(key.mac));
  // Every candidate is spoken for. The extension's own shortcut still works -
  // its handler calls sidePanel.open(), which the shim intercepts - so skip
  // rather than registering a command Chrome would drop on load.
  if (!free) return null;

  manifest.commands['toggle-arc-sidepanel'] = {
    suggested_key: free,
    description: 'Toggle the Arc-patched side panel',
  };
  return free;
}

/**
 * Patches an unpacked MV3 extension directory so its chrome.sidePanel calls
 * work in Arc. Writes the patched copy to outputDir and never modifies
 * sourceDir.
 *
 * panelMode:
 *   'overlay'   - docked iframe drawn on the page (default; works everywhere
 *                 a content script runs)
 *   'split-tab' - panel page opened as a real tab, for Arc's split view
 *                 (survives navigation, no host-page CSP concerns)
 */
function patchExtension({ sourceDir, outputDir, panelMode = 'overlay' }) {
  if (!sourceDir || !outputDir) {
    throw new Error('patchExtension requires both sourceDir and outputDir');
  }
  if (!PANEL_MODES.includes(panelMode)) {
    throw new Error(`Unknown panelMode "${panelMode}". Expected one of: ${PANEL_MODES.join(', ')}.`);
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

  const includeTabGroupsShim =
    Array.isArray(manifest.permissions) && manifest.permissions.includes('tabGroups');

  const sidePanelPages = findSidePanelPages(sourceDir, detection);

  copyExtension(sourceDir, outputDir);
  installPolyfillFiles(outputDir, { panelMode, includeTabGroupsShim });
  patchBackground(manifest, outputDir, {
    panelMode,
    defaultPath: detection.defaultPath,
    includeTabGroupsShim,
  });

  let exposedResources = [];
  let patchedPages = [];
  if (panelMode === 'split-tab') {
    // Nothing renders on the host page, so no content script and no
    // web_accessible_resources widening is needed.
    patchedPages = injectPanelTabsPatch(outputDir, sidePanelPages);
  } else {
    patchContentScripts(manifest);
    exposedResources = patchWebAccessibleResources(manifest, [
      ...sidePanelPages,
      ...findIconPaths(manifest),
    ]);
  }

  const command = patchCommands(manifest);

  // Arc does not render a side panel, and leaving the key in makes the browser
  // advertise a surface that never appears.
  delete manifest.side_panel;

  manifest.version_name = `${manifest.version} (arc-patched)`;

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    outputDir,
    manifest,
    detection,
    panelMode,
    exposedResources,
    patchedPages,
    command,
    includeTabGroupsShim,
  };
}

module.exports = { patchExtension, PANEL_MODES };
