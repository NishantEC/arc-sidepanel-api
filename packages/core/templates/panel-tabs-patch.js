'use strict';

// Injected into the side panel page by arc-sidepanel-api, in split-tab mode
// only. The page runs as its own browser tab there (so it can be dragged into
// an Arc split), which breaks the assumption every side panel page makes:
// that `chrome.tabs.query({active: true, currentWindow: true})` returns the
// page the user is looking at. In a split it can return the panel's own tab.
//
// The service worker is what actually knows which tab this panel was opened
// for and which tab is live in the other pane, so resolve through it on every
// call rather than pinning to whatever was active at mount.
{
  const nativeQuery = chrome.tabs.query.bind(chrome.tabs);

  async function hostTab() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ARC_SIDEPANEL_HOST_TAB' });
      if (!response || response.hostTabId == null) return null;
      return await chrome.tabs.get(response.hostTabId);
    } catch {
      return null;
    }
  }

  function wantsActiveTab(queryInfo) {
    return Boolean(
      queryInfo && queryInfo.active && (queryInfo.currentWindow || queryInfo.lastFocusedWindow)
    );
  }

  chrome.tabs.query = function query(queryInfo, callback) {
    const promise = (async () => {
      if (!wantsActiveTab(queryInfo)) return nativeQuery(queryInfo);
      const tab = await hostTab();
      return tab ? [tab] : nativeQuery(queryInfo);
    })();

    if (typeof callback !== 'function') return promise;
    promise.then(callback, () => callback([]));
    return undefined;
  };
}
