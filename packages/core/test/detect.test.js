'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSidePanelUsage } = require('../src/detect');

test('detects side_panel.default_path', () => {
  const result = detectSidePanelUsage({ side_panel: { default_path: 'panel.html' } });
  assert.equal(result.usesSidePanel, true);
  assert.equal(result.defaultPath, 'panel.html');
});

test('detects the "sidePanel" permission alone', () => {
  const result = detectSidePanelUsage({ permissions: ['sidePanel', 'storage'] });
  assert.equal(result.usesSidePanel, true);
  assert.equal(result.defaultPath, null);
});

test('reports no usage when neither is present', () => {
  const result = detectSidePanelUsage({ permissions: ['storage'] });
  assert.equal(result.usesSidePanel, false);
  assert.deepEqual(result.reasons, []);
});
