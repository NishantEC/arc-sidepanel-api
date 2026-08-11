'use strict';

// Injected by arc-sidepanel-api. Polyfills chrome.sidePanel by routing calls to
// the floating-panel.js content script, since Arc does not implement the
// native API. Arc does define real `chrome.sidePanel.open`/`setOptions`
// functions (they satisfy `typeof === 'function'`) - they just don't render
// any UI when called, since Arc has no side panel surface. That makes
// feature-detecting "does it actually work" from a service worker
// unreliable, so this always installs the polyfill unconditionally: this
// tool is only ever run in a browser where the caller already knows native
// chrome.sidePanel doesn't work, and the floating panel it installs behaves
// correctly even in a browser where the native API would have worked too.
{
  const perTabOptions = new Map();
  let globalOptions = { path: null, enabled: true };
  const panelBehavior = { openPanelOnActionClick: false };

  async function activeTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.id;
  }

  async function sendToTab(tabId, message) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Content script isn't injected on this page (e.g. chrome:// or the
      // Web Store) - nothing to do.
    }
  }

  chrome.sidePanel = {
    async setOptions(options = {}) {
      if (options.tabId != null) {
        perTabOptions.set(options.tabId, { path: options.path, enabled: options.enabled ?? true });
      } else {
        globalOptions = { path: options.path, enabled: options.enabled ?? true };
      }
    },

    async getOptions(options = {}) {
      if (options.tabId != null && perTabOptions.has(options.tabId)) {
        return perTabOptions.get(options.tabId);
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
      const tabId = options.tabId ?? (await activeTabId());
      if (tabId == null) return;
      const opts = perTabOptions.get(tabId) || globalOptions;
      if (!opts.path) return;
      await sendToTab(tabId, { type: 'ARC_SIDEPANEL_OPEN', url: chrome.runtime.getURL(opts.path) });
    },
  };

  if (chrome.action && chrome.action.onClicked) {
    chrome.action.onClicked.addListener(async (tab) => {
      if (!panelBehavior.openPanelOnActionClick) return;
      await chrome.sidePanel.open({ tabId: tab.id });
    });
  }

  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
      if (command !== 'toggle-arc-sidepanel') return;
      const tabId = await activeTabId();
      if (tabId == null) return;
      await sendToTab(tabId, { type: 'ARC_SIDEPANEL_TOGGLE' });
    });
  }
}
