'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchExtension } = require('../src/patch');

function makeFixture({ backgroundType, manifest: overrides = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-fixture-'));
  const manifest = {
    manifest_version: 3,
    name: 'Fixture Extension',
    version: '1.2.3',
    side_panel: { default_path: 'sidepanel.html' },
    permissions: ['sidePanel'],
    background: { service_worker: 'background.js', ...(backgroundType ? { type: backgroundType } : {}) },
    action: {},
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, 'background.js'), 'console.log("original background");', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'sidepanel.html'),
    '<!doctype html><html><head><title>Panel</title></head><body><div id="root"></div></body></html>',
    'utf8'
  );
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function outputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-'));
}

test('patches a classic (non-module) service worker extension', () => {
  const sourceDir = makeFixture();
  const out = outputDir();

  const { manifest } = patchExtension({ sourceDir, outputDir: out });

  assert.equal(manifest.background.service_worker, 'arc_polyfill/service-worker-entry.js');
  const entry = fs.readFileSync(path.join(out, 'arc_polyfill/service-worker-entry.js'), 'utf8');
  assert.match(entry, /importScripts\('config\.js', 'sw-shim\.js', '\.\.\/background\.js'\)/);

  assert.ok(fs.existsSync(path.join(out, 'arc_polyfill/floating-panel.js')));
  assert.ok(fs.existsSync(path.join(out, 'arc_polyfill/sw-shim.js')));

  assert.ok(
    manifest.content_scripts.some((cs) => cs.js.includes('arc_polyfill/floating-panel.js'))
  );
  assert.ok(manifest.commands['toggle-arc-sidepanel']);
  assert.equal(manifest.version_name, '1.2.3 (arc-patched)');
  assert.ok(!('side_panel' in manifest));

  // original source untouched
  assert.equal(
    fs.readFileSync(path.join(sourceDir, 'background.js'), 'utf8'),
    'console.log("original background");'
  );
});

test('patches a module-type service worker with import statements', () => {
  const sourceDir = makeFixture({ backgroundType: 'module' });
  const out = outputDir();

  patchExtension({ sourceDir, outputDir: out });

  const entry = fs.readFileSync(path.join(out, 'arc_polyfill/service-worker-entry.js'), 'utf8');
  assert.match(entry, /import '\.\/config\.js';/);
  assert.match(entry, /import '\.\/sw-shim\.js';/);
  assert.match(entry, /import '\.\.\/background\.js';/);
  // config must be evaluated before the shims that read it
  assert.ok(entry.indexOf("'./config.js'") < entry.indexOf("'./sw-shim.js'"));
});

test('records the manifest side panel path in the generated config', () => {
  const sourceDir = makeFixture();
  const out = outputDir();

  patchExtension({ sourceDir, outputDir: out });

  const config = fs.readFileSync(path.join(out, 'arc_polyfill/config.js'), 'utf8');
  assert.match(config, /__ARC_SIDEPANEL_DEFAULT_PATH = "sidepanel\.html"/);
  assert.match(config, /__ARC_FLOATING_PANEL_FILE = "arc_polyfill\/floating-panel\.js"/);
});

test('exposes the side panel page through web_accessible_resources', () => {
  const sourceDir = makeFixture();
  const out = outputDir();

  const { manifest, exposedResources } = patchExtension({ sourceDir, outputDir: out });

  assert.deepEqual(exposedResources, ['sidepanel.html']);
  assert.ok(
    manifest.web_accessible_resources.some(
      (entry) => entry.resources.includes('sidepanel.html') && entry.matches.includes('<all_urls>')
    )
  );
});

test('finds the panel page by name when the manifest has no side_panel key', () => {
  // Matches the shipping Claude extension: sidePanel permission only, path
  // supplied at runtime via sidePanel.setOptions.
  const sourceDir = makeFixture({
    manifest: { side_panel: undefined, permissions: ['sidePanel', 'tabs'] },
    files: { 'options.html': '<html></html>', 'offscreen.html': '<html></html>' },
  });
  const out = outputDir();

  const { exposedResources } = patchExtension({ sourceDir, outputDir: out });

  assert.deepEqual(exposedResources, ['sidepanel.html']);
});

test('exposes the extension icons so the panel title bar can render them', () => {
  const sourceDir = makeFixture({
    manifest: { icons: { 16: 'icon-16.png', 128: 'icon-128.png' }, action: { default_icon: 'bar.png' } },
  });
  const out = outputDir();

  const { exposedResources } = patchExtension({ sourceDir, outputDir: out });

  assert.deepEqual(exposedResources, ['sidepanel.html', 'icon-16.png', 'icon-128.png', 'bar.png']);
});

test('does not duplicate a web_accessible_resources entry that already exposes the page', () => {
  const sourceDir = makeFixture({
    manifest: {
      web_accessible_resources: [{ resources: ['sidepanel.html'], matches: ['<all_urls>'] }],
    },
  });
  const out = outputDir();

  const { manifest, exposedResources } = patchExtension({ sourceDir, outputDir: out });

  assert.deepEqual(exposedResources, []);
  assert.equal(manifest.web_accessible_resources.length, 1);
});

test('does not claim a keyboard shortcut the extension already uses', () => {
  const sourceDir = makeFixture({
    manifest: {
      commands: {
        'toggle-side-panel': {
          description: 'Toggle side panel',
          suggested_key: { default: 'Ctrl+E', mac: 'Command+E' },
        },
      },
    },
  });
  const out = outputDir();

  const { manifest, command } = patchExtension({ sourceDir, outputDir: out });

  assert.notDeepEqual(command, { default: 'Ctrl+E', mac: 'Command+E' });
  assert.equal(manifest.commands['toggle-side-panel'].suggested_key.mac, 'Command+E');
  assert.notEqual(manifest.commands['toggle-arc-sidepanel'].suggested_key.mac, 'Command+E');
});

test('installs the tab groups shim only when the extension declares tabGroups', () => {
  const withGroups = makeFixture({
    manifest: { permissions: ['sidePanel', 'tabGroups'] },
  });
  const outWith = outputDir();
  const resultWith = patchExtension({ sourceDir: withGroups, outputDir: outWith });

  assert.equal(resultWith.includeTabGroupsShim, true);
  assert.ok(fs.existsSync(path.join(outWith, 'arc_polyfill/tabgroups-shim.js')));
  assert.match(
    fs.readFileSync(path.join(outWith, 'arc_polyfill/service-worker-entry.js'), 'utf8'),
    /tabgroups-shim\.js/
  );

  const without = makeFixture();
  const outWithout = outputDir();
  const resultWithout = patchExtension({ sourceDir: without, outputDir: outWithout });

  assert.equal(resultWithout.includeTabGroupsShim, false);
  assert.ok(!fs.existsSync(path.join(outWithout, 'arc_polyfill/tabgroups-shim.js')));
});

test('split-tab mode injects the retargeting script into the panel page', () => {
  const sourceDir = makeFixture();
  const out = outputDir();

  const { manifest, patchedPages, panelMode } = patchExtension({
    sourceDir,
    outputDir: out,
    panelMode: 'split-tab',
  });

  assert.equal(panelMode, 'split-tab');
  assert.deepEqual(patchedPages, ['sidepanel.html']);
  assert.ok(fs.existsSync(path.join(out, 'arc_polyfill/panel-tabs-patch.js')));

  const html = fs.readFileSync(path.join(out, 'sidepanel.html'), 'utf8');
  assert.match(html, /<script src="\/arc_polyfill\/panel-tabs-patch\.js"><\/script>/);

  // nothing renders on the host page, so neither piece is needed
  assert.ok(!fs.existsSync(path.join(out, 'arc_polyfill/floating-panel.js')));
  assert.ok(!(manifest.content_scripts || []).some((cs) => cs.js.includes('arc_polyfill/floating-panel.js')));
  assert.equal(manifest.web_accessible_resources, undefined);

  assert.match(
    fs.readFileSync(path.join(out, 'arc_polyfill/config.js'), 'utf8'),
    /__ARC_SIDEPANEL_MODE = "split-tab"/
  );
});

test('split-tab injection lands before the page bundle and is idempotent', () => {
  const sourceDir = makeFixture();
  fs.writeFileSync(
    path.join(sourceDir, 'sidepanel.html'),
    '<!doctype html><html><head><script type="module" src="/bundle.js"></script></head><body></body></html>',
    'utf8'
  );
  const out = outputDir();

  patchExtension({ sourceDir, outputDir: out, panelMode: 'split-tab' });
  const html = fs.readFileSync(path.join(out, 'sidepanel.html'), 'utf8');
  assert.ok(html.indexOf('panel-tabs-patch.js') < html.indexOf('/bundle.js'));
  assert.equal(html.match(/panel-tabs-patch\.js/g).length, 1);
});

test('split-tab injection does not stack a second tag on a page that already has one', () => {
  const sourceDir = makeFixture();
  fs.writeFileSync(
    path.join(sourceDir, 'sidepanel.html'),
    '<!doctype html><html><head><script src="/arc_polyfill/panel-tabs-patch.js"></script>' +
      '<script type="module" src="/bundle.js"></script></head><body></body></html>',
    'utf8'
  );
  const out = outputDir();

  const { patchedPages } = patchExtension({ sourceDir, outputDir: out, panelMode: 'split-tab' });

  assert.deepEqual(patchedPages, ['sidepanel.html']);
  const html = fs.readFileSync(path.join(out, 'sidepanel.html'), 'utf8');
  assert.equal(html.match(/panel-tabs-patch\.js/g).length, 1);
});

test('overlay mode is the default and rejects an unknown mode', () => {
  const sourceDir = makeFixture();

  assert.equal(patchExtension({ sourceDir, outputDir: outputDir() }).panelMode, 'overlay');
  assert.throws(
    () => patchExtension({ sourceDir, outputDir: outputDir(), panelMode: 'sidebar' }),
    /Unknown panelMode "sidebar"/
  );
});

test('preserves an existing content_scripts array instead of overwriting it', () => {
  const sourceDir = makeFixture();
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts = [{ matches: ['https://example.com/*'], js: ['existing.js'] }];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'existing.js'), '', 'utf8');

  const out = outputDir();
  const { manifest: patched } = patchExtension({ sourceDir, outputDir: out });

  assert.equal(patched.content_scripts.length, 2);
  assert.ok(patched.content_scripts.some((cs) => cs.js.includes('existing.js')));
});

test('throws when the extension does not use sidePanel', () => {
  const sourceDir = makeFixture();
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.side_panel;
  delete manifest.permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  const out = outputDir();
  assert.throws(() => patchExtension({ sourceDir, outputDir: out }), /does not appear to use chrome\.sidePanel/);
});

test('throws for non-MV3 manifests', () => {
  const sourceDir = makeFixture();
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.manifest_version = 2;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  const out = outputDir();
  assert.throws(() => patchExtension({ sourceDir, outputDir: out }), /Only Manifest V3/);
});

test('refuses to patch an already-patched copy', () => {
  const sourceDir = makeFixture();
  const once = outputDir();
  patchExtension({ sourceDir, outputDir: once });

  // Patching the output again would generate an entry that importScripts itself.
  assert.throws(
    () => patchExtension({ sourceDir: once, outputDir: outputDir() }),
    /already an arc-patched extension/
  );
});
