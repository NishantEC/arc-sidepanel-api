'use strict';

// Injected by arc-sidepanel-api. Renders the extension's side-panel page as a
// docked panel, since Arc does not implement chrome.sidePanel.
//
// The panel squeezes the page rather than covering it: a native side panel
// narrows the viewport, and an overlay that hides the right-hand column of
// every site defeats the point of having page and panel side by side.
//
// Everything below the host element lives in a shadow root. Page stylesheets
// cannot reach into one, which matters because an inline style is not actually
// the last word - a page rule carrying !important beats it, and a single
// stray rule matching our container is enough to collapse the panel to nothing.
// The host's own styles are set with setProperty(..., 'important') for the
// same reason.

const HOST_ID = '__arc_sidepanel_host__';
const STYLE_ID = '__arc_sidepanel_style__';
const SQUEEZE_CLASS = '__arc_sidepanel_squeezed';
const LEFT_CLASS = '__arc_sidepanel_left';
const WIDTH_VAR = '--arc-sidepanel-width';
const WIDTH_KEY = 'arcSidePanelWidth';
const SIDE_KEY = 'arcSidePanelSide';

const DEFAULT_WIDTH_PX = 400;
const MIN_WIDTH_PX = 280;
// Leave the page something usable no matter how far the handle is dragged.
const MIN_PAGE_PX = 320;

const HOST_STYLE = {
  position: 'fixed',
  top: '0px',
  right: '0px',
  bottom: 'auto',
  left: 'auto',
  height: '100vh',
  margin: '0px',
  padding: '0px',
  border: '0px',
  'min-width': '0px',
  'max-width': 'none',
  'min-height': '0px',
  'max-height': 'none',
  'box-sizing': 'border-box',
  background: '#ffffff',
  'box-shadow': '-2px 0 16px rgba(0, 0, 0, 0.25)',
  transform: 'none',
  filter: 'none',
  opacity: '1',
  visibility: 'visible',
  'pointer-events': 'auto',
  'z-index': '2147483647',
};

const HEADER_HEIGHT_PX = 34;

const SHADOW_CSS = `
  :host { all: initial; }
  .wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 ${HEADER_HEIGHT_PX}px;
    height: ${HEADER_HEIGHT_PX}px;
    padding: 0 4px 0 10px;
    box-sizing: border-box;
    background: #f4f4f5;
    color: #27272a;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
    font: 500 12px/1 system-ui, -apple-system, sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }
  .icon { width: 15px; height: 15px; border-radius: 3px; flex: 0 0 auto; }
  .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .btn {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .btn:hover { background: rgba(0, 0, 0, 0.09); }
  .btn svg { width: 14px; height: 14px; display: block; }
  iframe {
    display: block;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    border: 0;
    background: #ffffff;
  }
  .handle {
    position: absolute;
    top: 0;
    left: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 2;
  }
  :host([data-side="left"]) .handle { left: auto; right: -3px; }
  @media (prefers-color-scheme: dark) {
    .header {
      background: #1f1f22;
      color: #e4e4e7;
      border-bottom-color: rgba(255, 255, 255, 0.1);
    }
    .btn:hover { background: rgba(255, 255, 255, 0.12); }
    iframe { background: #1f1f22; }
  }
`;

const ICON_RELOAD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';

// The service worker re-injects this file with chrome.scripting when a page
// predates the extension load, so guard against running twice on one document.
if (!window.__arcSidePanelInjected && window.top === window) {
  window.__arcSidePanelInjected = true;

  let panelWidth = DEFAULT_WIDTH_PX;

  function clampWidth(px) {
    const max = Math.max(MIN_WIDTH_PX, window.innerWidth - MIN_PAGE_PX);
    return Math.max(MIN_WIDTH_PX, Math.min(Number(px) || DEFAULT_WIDTH_PX, max));
  }

  // Squeezing <html> reflows normal-flow content into the remaining space.
  // Page elements that are themselves position:fixed still resolve against the
  // viewport and so stay full width - constraining those would mean putting a
  // transform on <html>, which would also capture this panel and break its own
  // fixed positioning.
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      :root.${SQUEEZE_CLASS} {
        width: calc(100% - var(${WIDTH_VAR}, ${DEFAULT_WIDTH_PX}px)) !important;
        min-width: 0 !important;
        max-width: none !important;
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function applyWidth(px) {
    panelWidth = clampWidth(px);
    document.documentElement.style.setProperty(WIDTH_VAR, `${panelWidth}px`);
    const host = document.getElementById(HOST_ID);
    if (host) host.style.setProperty('width', `${panelWidth}px`, 'important');
  }

  function setSqueeze(on) {
    ensureStyle();
    document.documentElement.classList.toggle(SQUEEZE_CLASS, on);
  }

  // Reloading or updating the extension orphans every content script and
  // extension-origin iframe already living in an open page: chrome.runtime is
  // torn out from under them and the panel's own bundle dies with
  // "Extension context invalidated". Left alone that strands a dead, empty
  // strip over a page that is still squeezed to make room for it, so detect it
  // and put the page back the way we found it.
  let aliveTimer = null;

  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function stopAliveWatch() {
    if (aliveTimer == null) return;
    clearInterval(aliveTimer);
    aliveTimer = null;
  }

  function teardown() {
    stopAliveWatch();
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
    document.documentElement.classList.remove(SQUEEZE_CLASS);
    document.documentElement.style.removeProperty(WIDTH_VAR);
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    // Release the guard so a freshly injected copy can take over this page
    // without waiting for a navigation.
    window.__arcSidePanelInjected = false;
  }

  function startAliveWatch() {
    if (aliveTimer != null) return;
    aliveTimer = setInterval(() => {
      if (!contextAlive()) teardown();
    }, 2000);
  }

  function startResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    const iframe = getIframe();
    // The iframe would otherwise swallow the mousemove stream the moment the
    // pointer crosses into it.
    if (iframe) iframe.style.pointerEvents = 'none';

    const onMove = (moveEvent) => applyWidth(startWidth + (startX - moveEvent.clientX));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (iframe) iframe.style.pointerEvents = '';
      try {
        chrome.storage.local.set({ [WIDTH_KEY]: panelWidth });
      } catch {
        // width just won't persist
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host && host.shadowRoot) return host;

    host = document.createElement('div');
    host.id = HOST_ID;
    for (const [property, value] of Object.entries(HOST_STYLE)) {
      host.style.setProperty(property, value, 'important');
    }
    host.style.setProperty('width', `${panelWidth}px`, 'important');
    host.style.setProperty('display', 'none', 'important');

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.addEventListener('mousedown', startResize);

    const iframe = document.createElement('iframe');
    iframe.allow = 'clipboard-read; clipboard-write';

    wrap.append(handle, buildHeader(iframe), iframe);
    root.append(style, wrap);
    document.documentElement.append(host);
    return host;
  }

  /**
   * A title bar above the panel, so its controls sit in their own strip rather
   * than floating over whatever the extension renders in its top-left corner.
   * Add further controls here - the row has room.
   */
  function buildHeader(iframe) {
    const manifest = chrome.runtime.getManifest();

    const header = document.createElement('div');
    header.className = 'header';

    const iconPath = pickIconPath(manifest.icons);
    if (iconPath) {
      const icon = document.createElement('img');
      icon.className = 'icon';
      icon.src = chrome.runtime.getURL(iconPath);
      icon.alt = '';
      // The icon is fetched by the host page, so it only loads if the patcher
      // exposed it. Drop it rather than leave a broken-image box in the bar.
      icon.addEventListener('error', () => icon.remove());
      header.append(icon);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = manifest.name || 'Side panel';
    header.append(title);

    header.append(
      iconButton(ICON_RELOAD, 'Reload panel', () => {
        const { src } = iframe;
        if (!src) return;
        iframe.src = 'about:blank';
        iframe.src = src;
      }),
      iconButton(ICON_CLOSE, 'Close panel', hidePanel)
    );

    return header;
  }

  function iconButton(svg, label, onClick) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.title = label;
    button.setAttribute('aria-label', label);
    // Static markup we authored, inside our own shadow root.
    button.innerHTML = svg;
    button.addEventListener('click', onClick);
    return button;
  }

  function pickIconPath(icons) {
    if (!icons) return null;
    const sizes = Object.keys(icons)
      .map(Number)
      .filter((size) => Number.isFinite(size))
      .sort((a, b) => a - b);
    if (sizes.length === 0) return null;
    return icons[sizes.find((size) => size >= 32) ?? sizes[sizes.length - 1]];
  }

  function getIframe() {
    const host = document.getElementById(HOST_ID);
    return host && host.shadowRoot ? host.shadowRoot.querySelector('iframe') : null;
  }

  function isOpen() {
    const host = document.getElementById(HOST_ID);
    return Boolean(host && host.style.display !== 'none');
  }

  // The service worker remembers which tabs have a panel open, so it can be
  // restored after a navigation tears this document down. It can't observe the
  // panel itself, so report every change.
  function reportState(open, url) {
    try {
      chrome.runtime.sendMessage({ type: 'ARC_SIDEPANEL_STATE', open, url });
    } catch {
      // Either the worker is asleep, which is harmless, or the extension was
      // reloaded and this whole script is orphaned.
      if (!contextAlive()) teardown();
    }
  }

  function showPanel(url) {
    const host = ensureHost();
    const iframe = getIframe();
    if (url && iframe && iframe.src !== url) iframe.src = url;
    applyWidth(panelWidth);
    host.style.setProperty('display', 'block', 'important');
    setSqueeze(true);
    startAliveWatch();
    reportState(true, url || (iframe && iframe.src) || null);
  }

  function hidePanel() {
    const host = document.getElementById(HOST_ID);
    if (host) host.style.setProperty('display', 'none', 'important');
    setSqueeze(false);
    stopAliveWatch();
    reportState(false);
  }

  // The panel URL is only known to the service worker (the extension supplies
  // it via sidePanel.setOptions), so a toggle that opens a never-opened panel
  // has to go ask for it rather than showing an empty iframe.
  async function panelUrl() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ARC_SIDEPANEL_REQUEST_URL' });
      return response && response.url;
    } catch {
      return null;
    }
  }

  async function togglePanel(url) {
    if (isOpen()) {
      hidePanel();
      return;
    }
    const iframe = getIframe();
    const src = url || (iframe && iframe.src) || (await panelUrl());
    showPanel(src);
  }

  // Keep the page readable if the window shrinks below what the current split
  // allows.
  window.addEventListener('resize', () => {
    if (isOpen()) applyWidth(panelWidth);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'ARC_SIDEPANEL_OPEN') showPanel(message.url);
    if (message?.type === 'ARC_SIDEPANEL_CLOSE') hidePanel();
    if (message?.type === 'ARC_SIDEPANEL_TOGGLE') togglePanel(message.url);
  });

  // This document is new - either a first visit or a navigation that destroyed
  // the previous panel. Restore the chosen width, then put the panel back if
  // this tab had one open.
  (async () => {
    try {
      const stored = await chrome.storage.local.get(WIDTH_KEY);
      if (stored && typeof stored[WIDTH_KEY] === 'number') panelWidth = clampWidth(stored[WIDTH_KEY]);
    } catch {
      // stick with the default
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'ARC_SIDEPANEL_RESTORE' });
      if (response && response.url) showPanel(response.url);
    } catch {
      // nothing to restore
    }
  })();
}
