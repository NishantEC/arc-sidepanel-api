'use strict';

// Injected by arc-sidebar-api. Polyfills chrome.sidePanel by routing calls to
// the floating-panel.js content script, since Arc does not implement the
// native API. Only activates if chrome.sidePanel isn't already present, so a
// build patched by this tool still behaves natively in a real Chromium build.

if (!chrome.sidePanel) {
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
} else {
  console.warn(
    '[arc-sidebar-api] chrome.sidePanel already exists in this browser; not overriding it. ' +
      'If it exists but does not work, please open an issue.'
  );
}
