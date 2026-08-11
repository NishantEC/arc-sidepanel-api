'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchExtension } = require('../src/patch');

function makeFixture({ backgroundType } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-fixture-'));
  const manifest = {
    manifest_version: 3,
    name: 'Fixture Extension',
    version: '1.2.3',
    side_panel: { default_path: 'sidepanel.html' },
    permissions: ['sidePanel'],
    background: { service_worker: 'background.js', ...(backgroundType ? { type: backgroundType } : {}) },
    action: {},
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, 'background.js'), 'console.log("original background");', 'utf8');
  fs.writeFileSync(path.join(dir, 'sidepanel.html'), '<html></html>', 'utf8');
  return dir;
}

test('patches a classic (non-module) service worker extension', () => {
  const sourceDir = makeFixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-'));

  const { manifest } = patchExtension({ sourceDir, outputDir });

  assert.equal(manifest.background.service_worker, 'arc_polyfill/service-worker-entry.js');
  const entry = fs.readFileSync(path.join(outputDir, 'arc_polyfill/service-worker-entry.js'), 'utf8');
  assert.match(entry, /importScripts\('sw-shim\.js', '\.\.\/background\.js'\)/);

  assert.ok(fs.existsSync(path.join(outputDir, 'arc_polyfill/floating-panel.js')));
  assert.ok(fs.existsSync(path.join(outputDir, 'arc_polyfill/sw-shim.js')));

  assert.ok(
    manifest.content_scripts.some((cs) => cs.js.includes('arc_polyfill/floating-panel.js'))
  );
  assert.ok(manifest.commands['toggle-arc-sidepanel']);
  assert.equal(manifest.version_name, '1.2.3 (arc-patched)');

  // original source untouched
  assert.equal(
    fs.readFileSync(path.join(sourceDir, 'background.js'), 'utf8'),
    'console.log("original background");'
  );
});

test('patches a module-type service worker with import statements', () => {
  const sourceDir = makeFixture({ backgroundType: 'module' });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-'));

  patchExtension({ sourceDir, outputDir });

  const entry = fs.readFileSync(path.join(outputDir, 'arc_polyfill/service-worker-entry.js'), 'utf8');
  assert.match(entry, /import '\.\/sw-shim\.js';/);
  assert.match(entry, /import '\.\.\/background\.js';/);
});

test('preserves an existing content_scripts array instead of overwriting it', () => {
  const sourceDir = makeFixture();
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts = [{ matches: ['https://example.com/*'], js: ['existing.js'] }];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'existing.js'), '', 'utf8');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-'));
  const { manifest: patched } = patchExtension({ sourceDir, outputDir });

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

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-'));
  assert.throws(() => patchExtension({ sourceDir, outputDir }), /does not appear to use chrome\.sidePanel/);
});

test('throws for non-MV3 manifests', () => {
  const sourceDir = makeFixture();
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.manifest_version = 2;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-'));
  assert.throws(() => patchExtension({ sourceDir, outputDir }), /Only Manifest V3/);
});
