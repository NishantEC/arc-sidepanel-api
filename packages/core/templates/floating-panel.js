'use strict';

// Injected by arc-sidebar-api. Renders the extension's side-panel page as a
// docked floating panel, since Arc does not implement chrome.sidePanel.

const HOST_ID = '__arc_sidepanel_host__';
const PANEL_WIDTH_PX = 400;

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (host) return host;

  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = `
    all: initial;
    position: fixed;
    top: 0;
    right: 0;
    width: ${PANEL_WIDTH_PX}px;
    height: 100vh;
    z-index: 2147483647;
    box-shadow: -2px 0 16px rgba(0, 0, 0, 0.25);
    display: none;
    background: #fff;
  `;

  const closeButton = document.createElement('button');
  closeButton.textContent = '✕';
  closeButton.title = 'Close panel';
  closeButton.style.cssText = `
    all: initial;
    position: absolute;
    top: 8px;
    left: -34px;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    cursor: pointer;
    font-size: 13px;
    line-height: 26px;
    text-align: center;
    font-family: system-ui, sans-serif;
  `;
  closeButton.addEventListener('click', hidePanel);

  const iframe = document.createElement('iframe');
  iframe.id = `${HOST_ID}_iframe`;
  iframe.style.cssText = 'width: 100%; height: 100%; border: none; display: block;';

  host.append(closeButton, iframe);
  document.documentElement.append(host);
  return host;
}

function showPanel(url) {
  const host = ensureHost();
  const iframe = document.getElementById(`${HOST_ID}_iframe`);
  if (url && iframe.src !== url) iframe.src = url;
  host.style.display = 'block';
}

function hidePanel() {
  const host = document.getElementById(HOST_ID);
  if (host) host.style.display = 'none';
}

function togglePanel() {
  const host = document.getElementById(HOST_ID);
  const isOpen = host && host.style.display !== 'none';
  if (isOpen) hidePanel();
  else ensureHost().style.display = 'block';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ARC_SIDEPANEL_OPEN') showPanel(message.url);
  if (message?.type === 'ARC_SIDEPANEL_CLOSE') hidePanel();
  if (message?.type === 'ARC_SIDEPANEL_TOGGLE') togglePanel();
});
