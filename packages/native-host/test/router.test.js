'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleMessage } = require('../src/router');

test('ping returns pong with a version', () => {
  const response = handleMessage({ type: 'ping' });
  assert.equal(response.type, 'pong');
  assert.equal(typeof response.version, 'string');
});

test('unknown message types return an error response', () => {
  const response = handleMessage({ type: 'something-unsupported' });
  assert.equal(response.type, 'error');
  assert.match(response.error, /Unknown message type/);
});

test('patch returns patch-error for an unknown extension id', () => {
  const response = handleMessage({ type: 'patch', id: 'does-not-exist' });
  assert.equal(response.type, 'patch-error');
  assert.match(response.error, /No installed extension found/);
});

test('reveal shells out to `open -R` and returns nothing', () => {
  const calls = [];
  const response = handleMessage(
    { type: 'reveal', path: '/tmp/some-dir' },
    { openInFinder: (cmd, args) => calls.push([cmd, args]) }
  );
  assert.equal(response, null);
  assert.deepEqual(calls, [['open', ['-R', '/tmp/some-dir']]]);
});

test('patch writes a patched copy for a matching installed extension', (t) => {
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-native-host-'));
  const extDir = path.join(extensionsDir, 'abcId', '1.0.0');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Test Ext',
      version: '1.0.0',
      side_panel: { default_path: 'panel.html' },
      background: { service_worker: 'bg.js' },
    })
  );
  fs.writeFileSync(path.join(extDir, 'bg.js'), '', 'utf8');
  fs.writeFileSync(path.join(extDir, 'panel.html'), '', 'utf8');

  t.mock.method(require('@arc-sidepanel-api/core'), 'listInstalledExtensions', () => [
    { id: 'abcId', version: '1.0.0', dir: extDir, name: 'Test Ext', usesSidePanel: true, defaultPath: 'panel.html', reasons: [] },
  ]);

  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sidepanel-api-output-root-'));
  const response = handleMessage({ type: 'patch', id: 'abcId' }, { outputRoot });

  assert.equal(response.type, 'patch-result');
  assert.ok(fs.existsSync(path.join(response.outputDir, 'manifest.json')));
});
