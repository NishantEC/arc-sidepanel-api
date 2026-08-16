'use strict';

const HOST_NAME = 'com.arc_sidepanel_api.host';
const rowTemplate = document.getElementById('extension-row-template');
const statusEl = document.getElementById('status');
const needsPatchList = document.getElementById('needs-patch-list');
const needsPatchEmpty = document.getElementById('needs-patch-empty');
const otherList = document.getElementById('other-list');

let port;
let managementById = new Map();

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind || ''}`.trim();
}

function pickIcon(managementInfo) {
  if (!managementInfo || !managementInfo.icons || managementInfo.icons.length === 0) return '';
  return managementInfo.icons[managementInfo.icons.length - 1].url;
}

function renderRow(ext, listEl, { actionable }) {
  const node = rowTemplate.content.cloneNode(true);
  const li = node.querySelector('.extension-row');
  li.dataset.extensionId = ext.id;

  const managementInfo = managementById.get(ext.id);
  node.querySelector('.extension-icon').src = pickIcon(managementInfo);
  node.querySelector('.extension-name').textContent = ext.name;
  node.querySelector('.extension-version').textContent = `v${ext.version}`;

  // Extensions like Sider ship their own in-page panel alongside the native
  // one. Those already work in Arc, so say so before offering to patch.
  const ownUiNote = node.querySelector('.own-ui-note');
  if (actionable && ext.ownInPageUI && ext.ownInPageUI.likelyHasOwnPanel) {
    ownUiNote.hidden = false;
    ownUiNote.textContent =
      'Already renders its own panel inside the page, so it probably works in Arc ' +
      `without patching (${ext.ownInPageUI.reasons[0]}). Check the extension's own ` +
      'display-mode setting first.';
  }

  const patchButton = node.querySelector('.patch-button');
  const panelModeLabel = node.querySelector('.panel-mode');
  const panelModeSelect = node.querySelector('.panel-mode-select');
  const resultBox = node.querySelector('.patch-result');
  const resultText = node.querySelector('.patch-result-text');
  const revealButton = node.querySelector('.reveal-button');
  const splitTabStep = node.querySelector('.split-tab-step');
  const errorBox = node.querySelector('.patch-error');

  if (!actionable) {
    patchButton.remove();
    panelModeLabel.remove();
  } else {
    patchButton.addEventListener('click', () => {
      patchButton.disabled = true;
      patchButton.textContent = 'Patching…';
      errorBox.hidden = true;
      port.postMessage({ type: 'patch', id: ext.id, panelMode: panelModeSelect.value });
    });
  }

  li.updateWithResult = (outputDir, panelMode) => {
    patchButton.hidden = true;
    panelModeLabel.hidden = true;
    resultBox.hidden = false;
    splitTabStep.hidden = panelMode !== 'split-tab';
    resultText.textContent = `Patched: ${outputDir}`;
    revealButton.addEventListener('click', () => {
      port.postMessage({ type: 'reveal', path: outputDir });
    });
  };

  li.updateWithError = (message) => {
    patchButton.disabled = false;
    patchButton.textContent = 'Retry patch';
    errorBox.hidden = false;
    errorBox.textContent = message;
  };

  listEl.appendChild(node);
  return listEl.lastElementChild;
}

function renderExtensions(extensions) {
  needsPatchList.textContent = '';
  otherList.textContent = '';

  const actionable = extensions.filter((ext) => ext.usesSidePanel);
  const rest = extensions.filter((ext) => !ext.usesSidePanel);

  needsPatchEmpty.hidden = actionable.length > 0;
  for (const ext of actionable) renderRow(ext, needsPatchList, { actionable: true });
  for (const ext of rest) renderRow(ext, otherList, { actionable: false });
}

function findRow(id) {
  return document.querySelector(`.extension-row[data-extension-id="${CSS.escape(id)}"]`);
}

function connect() {
  port = chrome.runtime.connectNative(HOST_NAME);

  port.onMessage.addListener((message) => {
    switch (message.type) {
      case 'pong':
        setStatus(`Connected to native host (v${message.version}).`, 'ready');
        port.postMessage({ type: 'list-installed' });
        break;

      case 'list-installed-result':
        renderExtensions(message.extensions.filter((ext) => ext.id !== chrome.runtime.id));
        break;

      case 'patch-result': {
        const row = findRow(message.id);
        if (row) row.updateWithResult(message.outputDir, message.panelMode);
        break;
      }

      case 'patch-error': {
        const row = findRow(message.id);
        if (row) row.updateWithError(message.error);
        break;
      }

      case 'error':
        setStatus(message.error, 'error');
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    const lastError = chrome.runtime.lastError;
    setStatus(
      `Couldn't reach the native host${lastError ? `: ${lastError.message}` : ''}. ` +
        'Have you run packages/native-host/install.sh? See the README.',
      'error'
    );
  });

  port.postMessage({ type: 'ping' });
}

chrome.management.getAll((extensions) => {
  managementById = new Map(extensions.map((ext) => [ext.id, ext]));
  connect();
});
