'use strict';

// Injected by arc-sidepanel-api. Polyfills chrome.sidePanel by routing calls
// somewhere Arc can actually render, since Arc does not implement the native
// API. Arc does define real `chrome.sidePanel.open`/`setOptions` functions
// (they satisfy `typeof === 'function'`) - they just don't render any UI when
// called, since Arc has no side panel surface. That makes feature-detecting
// "does it actually work" from a service worker unreliable, so this always
// installs the polyfill unconditionally: this tool is only ever run in a
// browser where the caller already knows native chrome.sidePanel doesn't work,
// and the replacement behaves correctly even where the native API would have
// worked too.
//
// Two render modes, chosen at patch time:
//   overlay    - a docked iframe drawn on the page by floating-panel.js
//   split-tab  - the panel page opened as a real browser tab, which the user
//                drags into an Arc split view once and Arc then remembers
{
  const MODE = globalThis.__ARC_SIDEPANEL_MODE === 'split-tab' ? 'split-tab' : 'overlay';

  const perTabOptions = new Map();
  let globalOptions = { path: null, enabled: true };
  const panelBehavior = { openPanelOnActionClick: false };

  // split-tab mode. One panel per browser window, not per tab: a split pane is
  // a property of the window, and keying by tab meant switching pages and
  // reopening spawned a second panel instead of reusing the one already
  // sitting in the split.
  //   panelByWindow: windowId  -> panelTabId
  //   hostByPanel:   panelTabId -> last known tab that panel was opened for
  // Both mirrored to storage.session so the pairing survives a worker restart.
  const panelByWindow = new Map();
  const hostByPanel = new Map();

  // overlay mode: tabId -> panel URL, for tabs whose panel is currently open.
  // The overlay lives in the page's DOM, so a navigation destroys it; this is
  // what lets the content script put it back on the next page instead of the
  // panel vanishing every time the user clicks a link.
  const openPanels = new Map();

  const STORE_KEY = '__arcPanelTabs';

  // Set when one of the extension's own shortcuts fires. A sidePanel.open()
  // arriving inside this window is treated as a toggle, so pressing the panel
  // shortcut a second time closes the panel. Our command listener runs before
  // the extension's own, because the shim is imported ahead of its worker.
  let commandOpenUntil = 0;
  const COMMAND_WINDOW_MS = 500;

  const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
  const nativeGet = chrome.tabs.get.bind(chrome.tabs);

  const ready = (async () => {
    try {
      const saved = (await chrome.storage.session.get(STORE_KEY))[STORE_KEY];
      for (const [windowId, panelTabId] of (saved && saved.panelByWindow) || []) {
        panelByWindow.set(Number(windowId), panelTabId);
      }
      for (const [panelTabId, hostTabId] of (saved && saved.hostByPanel) || []) {
        hostByPanel.set(Number(panelTabId), hostTabId);
      }
      for (const [tabId, url] of (saved && saved.openPanels) || []) {
        openPanels.set(Number(tabId), url);
      }
    } catch {
      // storage.session unavailable - stay in-memory only
    }
  })();

  function save() {
    try {
      return chrome.storage.session.set({
        [STORE_KEY]: {
          panelByWindow: [...panelByWindow],
          hostByPanel: [...hostByPanel],
          openPanels: [...openPanels],
        },
      });
    } catch {
      return Promise.resolve();
    }
  }

  const isPanelTab = (tabId) => hostByPanel.has(tabId);

  async function tabExists(tabId) {
    try {
      await nativeGet(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Maps a panel tab back to the page it is acting on. Callers hand us whatever
   * tab was active, and once the panel has focus - which happens the moment you
   * click into it to type - that is the panel's own tab. Left unresolved, the
   * extension asks us to open a panel for a panel, finds no pairing, and opens
   * another one on every click.
   */
  async function resolveHostTab(tabId) {
    if (MODE !== 'split-tab' || tabId == null) return tabId;
    await ready;
    if (!isPanelTab(tabId)) return tabId;

    // Prefer whatever is live in the other pane right now.
    try {
      const panelTab = await nativeGet(tabId);
      const active = await nativeQuery({ active: true, windowId: panelTab.windowId });
      const candidate = active.find((tab) => tab.id !== tabId && !isPanelTab(tab.id));
      if (candidate) return candidate.id;
    } catch {
      // fall through to the remembered host
    }

    const remembered = hostByPanel.get(tabId);
    if (remembered != null && (await tabExists(remembered))) return remembered;
    return tabId;
  }

  async function activeTabId() {
    const [tab] = await nativeQuery({ active: true, currentWindow: true });
    return resolveHostTab(tab && tab.id);
  }

  // The content script may not be present yet: it is registered at
  // document_idle, so pages already open when the extension loaded never got
  // it, and chrome:// / Web Store pages never will. Try the message first,
  // then inject on demand and retry once.
  async function sendToTab(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // fall through to on-demand injection
    }

    if (!chrome.scripting || !chrome.scripting.executeScript) return undefined;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [globalThis.__ARC_FLOATING_PANEL_FILE],
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Restricted page (chrome://, the Web Store, a PDF viewer). Nothing to do.
      return undefined;
    }
  }

  function panelUrlForTab(tabId) {
    const opts = perTabOptions.get(tabId) || globalOptions;
    if (opts.enabled === false) return null;
    const path = opts.path || globalThis.__ARC_SIDEPANEL_DEFAULT_PATH;
    if (!path) return null;

    const url = new URL(chrome.runtime.getURL(path));
    if (MODE === 'split-tab') {
      // Extensions commonly bake the target tab into the panel URL and read it
      // once at mount. In a split the user keeps browsing in the other pane, so
      // a pinned id goes stale immediately; drop it and let panel-tabs-patch.js
      // resolve the host tab live instead.
      url.searchParams.delete('tabId');
    }
    return url.href;
  }

  async function openSplitTab(hostTabId, url, { toggle }) {
    await ready;

    let hostTab;
    try {
      hostTab = await nativeGet(hostTabId);
    } catch {
      return;
    }

    const existing = panelByWindow.get(hostTab.windowId);
    if (existing != null && (await tabExists(existing))) {
      if (toggle) {
        panelByWindow.delete(hostTab.windowId);
        hostByPanel.delete(existing);
        await save();
        try {
          await chrome.tabs.remove(existing);
        } catch {
          // already gone
        }
        return;
      }
      hostByPanel.set(existing, hostTabId);
      await save();
      await chrome.tabs.update(existing, { active: true });
      return;
    }

    const panelTab = await chrome.tabs.create({
      url,
      index: hostTab.index + 1,
      openerTabId: hostTabId,
      active: true,
    });
    panelByWindow.set(hostTab.windowId, panelTab.id);
    hostByPanel.set(panelTab.id, hostTabId);
    await save();
  }

  const impl = {
    async setOptions(options = {}) {
      if (options.tabId != null) {
        // Key by the page, not the panel: extensions call this with whatever
        // tab was active, which may be the panel itself.
        const tabId = await resolveHostTab(options.tabId);
        perTabOptions.set(tabId, { path: options.path, enabled: options.enabled ?? true });
      } else {
        globalOptions = { path: options.path, enabled: options.enabled ?? true };
      }
    },

    async getOptions(options = {}) {
      if (options.tabId != null) {
        const tabId = await resolveHostTab(options.tabId);
        if (perTabOptions.has(tabId)) return perTabOptions.get(tabId);
      }
      return globalOptions;
    },

    async setPanelBehavior(behavior = {}) {
      Object.assign(panelBehavior, behavior);
    },

    async getPanelBehavior() {
      return panelBehavior;
    },

    async open(options = {}) {
      const tabId =
        options.tabId != null ? await resolveHostTab(options.tabId) : await activeTabId();
      if (tabId == null) return;

      const url = panelUrlForTab(tabId);
      if (!url) {
        console.warn(
          '[arc-sidepanel-api] sidePanel.open() called for tab %s but no panel path is known. ' +
            'The extension never called sidePanel.setOptions({path}) and its manifest has no ' +
            'side_panel.default_path.',
          tabId
        );
        return;
      }

      const toggle = Date.now() < commandOpenUntil;
      commandOpenUntil = 0;

      if (MODE === 'split-tab') {
        await openSplitTab(tabId, url, { toggle });
        return;
      }
      await sendToTab(tabId, { type: toggle ? 'ARC_SIDEPANEL_TOGGLE' : 'ARC_SIDEPANEL_OPEN', url });
    },
  };

  // Assign method-by-method rather than replacing the namespace wholesale.
  // On some Chromium builds `chrome.sidePanel` is a non-writable accessor, and
  // `chrome.sidePanel = {}` under 'use strict' throws a TypeError - which would
  // abort this module and take the extension's own service worker down with it,
  // breaking the extension far worse than the missing panel did.
  function install(target, name, fn) {
    try {
      target[name] = fn;
      if (target[name] === fn) return true;
    } catch {
      // non-writable; try defineProperty below
    }
    try {
      Object.defineProperty(target, name, { value: fn, writable: true, configurable: true });
      return target[name] === fn;
    } catch {
      return false;
    }
  }

  if (!chrome.sidePanel) {
    try {
      chrome.sidePanel = {};
    } catch {
      // namespace itself is locked down; the fallback below covers it
    }
  }
  const target = chrome.sidePanel || (globalThis.__arcSidePanel = {});

  for (const [name, fn] of Object.entries(impl)) {
    if (!install(target, name, fn)) {
      console.error('[arc-sidepanel-api] could not install chrome.sidePanel.%s', name);
    }
  }

  if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(async (tab) => {
      // Extensions that call sidePanel.open() from their own click handler
      // route through impl.open above; this covers the ones that instead rely
      // on the browser opening the panel for them.
      if (!panelBehavior.openPanelOnActionClick) return;
      await impl.open({ tabId: tab.id });
    });
  }

  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
      if (command !== 'toggle-arc-sidepanel') {
        commandOpenUntil = Date.now() + COMMAND_WINDOW_MS;
        return;
      }

      const tabId = await activeTabId();
      if (tabId == null) return;
      const url = panelUrlForTab(tabId);
      if (!url) return;

      if (MODE === 'split-tab') {
        await openSplitTab(tabId, url, { toggle: true });
        return;
      }
      await sendToTab(tabId, { type: 'ARC_SIDEPANEL_TOGGLE', url });
    });
  }

  if (MODE === 'split-tab') {
    // The panel is a real tab, so the moment the user focuses it to type,
    // `tabs.query({active: true, ...})` starts answering with the panel's own
    // tab. Extensions use that call to decide what page they are acting on -
    // Claude's agent tools throw "No active tab" - so swap any panel tab in an
    // active-tab result for the page it is paired with. panel-tabs-patch.js
    // does the same job inside the panel page; this covers the service worker.
    //
    // Installed before the extension's own worker is imported, so it sees the
    // patched version. The tab groups shim wraps this in turn and delegates
    // non-group queries down to it.
    chrome.tabs.query = function query(queryInfo, callback) {
      const promise = (async () => {
        const tabs = await nativeQuery(queryInfo);
        if (!queryInfo || !queryInfo.active) return tabs;

        await ready;
        const out = [];
        const seen = new Set();
        for (const tab of tabs) {
          let resolved = tab;
          if (isPanelTab(tab.id)) {
            const hostTabId = await resolveHostTab(tab.id);
            if (hostTabId === tab.id) continue; // nothing better to offer
            try {
              resolved = await nativeGet(hostTabId);
            } catch {
              continue;
            }
          }
          if (seen.has(resolved.id)) continue;
          seen.add(resolved.id);
          out.push(resolved);
        }
        return out;
      })();

      if (typeof callback !== 'function') return promise;
      promise.then(callback, () => callback([]));
      return undefined;
    };

    chrome.tabs.onRemoved.addListener(async (tabId) => {
      await ready;
      if (!isPanelTab(tabId)) return;
      hostByPanel.delete(tabId);
      for (const [windowId, panelTabId] of panelByWindow) {
        if (panelTabId === tabId) panelByWindow.delete(windowId);
      }
      await save();
    });
  } else {
    chrome.tabs.onRemoved.addListener(async (tabId) => {
      await ready;
      if (!openPanels.delete(tabId)) return;
      await save();
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // The content script asks for its panel URL when toggled open before the
    // extension has ever called sidePanel.open() for that tab.
    if (message?.type === 'ARC_SIDEPANEL_REQUEST_URL') {
      const tabId = sender.tab && sender.tab.id;
      sendResponse({ url: tabId == null ? null : panelUrlForTab(tabId) });
      return true;
    }

    // overlay mode: a freshly injected content script asking whether this tab's
    // panel was open before the page navigated. Answering here rather than
    // pushing from a tabs.onUpdated listener avoids racing the injection.
    if (message?.type === 'ARC_SIDEPANEL_RESTORE') {
      const tabId = sender.tab && sender.tab.id;
      ready.then(
        () => sendResponse({ url: (tabId != null && openPanels.get(tabId)) || null }),
        () => sendResponse({ url: null })
      );
      return true;
    }

    // overlay mode: the content script is the source of truth for whether the
    // panel actually rendered, so it reports its own state rather than us
    // assuming a sendMessage succeeded.
    if (message?.type === 'ARC_SIDEPANEL_STATE') {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) {
        if (message.open && message.url) openPanels.set(tabId, message.url);
        else openPanels.delete(tabId);
        save();
      }
      sendResponse({ ok: true });
      return true;
    }

    // split-tab mode: the panel page asks which tab it is acting on.
    if (message?.type === 'ARC_SIDEPANEL_HOST_TAB') {
      const panelTabId = sender.tab && sender.tab.id;
      if (panelTabId == null) {
        sendResponse({ hostTabId: null });
        return true;
      }
      resolveHostTab(panelTabId).then(
        (hostTabId) => sendResponse({ hostTabId: hostTabId === panelTabId ? null : hostTabId }),
        () => sendResponse({ hostTabId: null })
      );
      return true;
    }

    return undefined;
  });
}
