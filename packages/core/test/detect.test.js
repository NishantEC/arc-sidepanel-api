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

const fsx = require('node:fs');
const osx = require('node:os');
const pathx = require('node:path');
const { detectOwnInPageUI } = require('../src/detect');

function ownUiFixture({ contentScriptSource, matches = ['<all_urls>'], pages = [] }) {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'arc-own-ui-'));
  fsx.writeFileSync(pathx.join(dir, 'content.js'), contentScriptSource, 'utf8');
  for (const page of pages) fsx.writeFileSync(pathx.join(dir, page), '<html></html>', 'utf8');
  return { dir, manifest: { content_scripts: [{ matches, js: ['content.js'] }] } };
}

test('flags an extension whose page-wide content script embeds its own panel page', () => {
  // Matches Sider: content-all.js runs on <all_urls> and names sidepanel.html.
  const { dir, manifest } = ownUiFixture({
    contentScriptSource: 'const u = chrome.runtime.getURL("sidepanel.html");',
    pages: ['sidepanel.html'],
  });

  const result = detectOwnInPageUI(dir, manifest);

  assert.equal(result.likelyHasOwnPanel, true);
  assert.deepEqual(result.embeddedPages, ['sidepanel.html']);
  assert.match(result.reasons[0], /embeds sidepanel\.html/);
});

test('does not flag a content script that only names a non-panel page', () => {
  const { dir, manifest } = ownUiFixture({
    contentScriptSource: 'open(chrome.runtime.getURL("options.html"));',
    pages: ['options.html'],
  });

  const result = detectOwnInPageUI(dir, manifest);

  assert.equal(result.likelyHasOwnPanel, false);
  assert.deepEqual(result.embeddedPages, ['options.html']);
});

test('ignores html names the extension does not actually ship', () => {
  // Matches Claude and CSS Peeper: broad content scripts that embed nothing.
  const { dir, manifest } = ownUiFixture({
    contentScriptSource: 'fetch("https://example.com/sidepanel.html");',
  });

  const result = detectOwnInPageUI(dir, manifest);

  assert.equal(result.likelyHasOwnPanel, false);
  assert.deepEqual(result.embeddedPages, []);
});

test('ignores content scripts scoped to specific sites', () => {
  const { dir, manifest } = ownUiFixture({
    contentScriptSource: 'chrome.runtime.getURL("sidepanel.html");',
    matches: ['https://example.com/*'],
    pages: ['sidepanel.html'],
  });

  assert.equal(detectOwnInPageUI(dir, manifest).likelyHasOwnPanel, false);
});

test('flags an extension that renders a large shadow-DOM UI with no page to name', () => {
  // Matches CSS Peeper: a 1.6MB inspector panel built directly in JS, so there
  // is no .html file for the embed check to find.
  const { dir, manifest } = ownUiFixture({
    contentScriptSource: `const r = el.attachShadow({mode:'open'});//${'x'.repeat(400 * 1024)}`,
  });

  const result = detectOwnInPageUI(dir, manifest);

  assert.equal(result.likelyHasOwnPanel, true);
  assert.match(result.reasons[0], /shadow-DOM UI into every page/);
});

test('does not flag a small shadow-DOM helper', () => {
  // Matches Claude's 18KB in-page agent indicator: a shadow root, but decorating
  // the page rather than rendering a panel into it.
  const { dir, manifest } = ownUiFixture({
    contentScriptSource: `el.attachShadow({mode:'open'});//${'x'.repeat(18 * 1024)}`,
  });

  assert.equal(detectOwnInPageUI(dir, manifest).likelyHasOwnPanel, false);
});
