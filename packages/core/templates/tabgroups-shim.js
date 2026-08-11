'use strict';

// Injected by arc-sidepanel-api for extensions that declare the "tabGroups"
// permission. Approach derived from quardianwolf/claude-arc-patch (MIT).
//
// Arc exposes the Chrome Tab Groups API surface - `chrome.tabGroups` is an
// object, `chrome.tabs.group` is a function, `TAB_GROUP_ID_NONE === -1` - but
// the calls never settle: `chrome.tabs.group()` returns a promise that hangs
// forever. Feature detection therefore cannot tell you it is broken; only
// calling it does, and by then you have already deadlocked.
//
// Extensions that funnel work through tab groups (Claude's browser-automation
// layer puts every navigation into an "MCP tab group") hang on the first call
// and time out. This replaces the tab-group methods with an in-memory
// emulation keyed by synthetic group IDs, and intercepts the tabs.query /
// tabs.get paths that read group membership so the rest of the extension keeps
// working unmodified. Visual grouping is cosmetic - Arc does not render tab
// groups at all - so emulation loses nothing.
//
// State is mirrored to chrome.storage.session so it survives MV3 service
// worker restarts.
{
  const NONE = -1;
  const STORE_KEY = '__arcEmulatedTabGroups';

  const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const Color = Object.fromEntries(COLORS.flatMap((c) => [[c, c], [c.toUpperCase(), c]]));

  let nextGroupId = 900001;
  /** @type {Map<number, {title: string, color: string, collapsed: boolean, windowId: number|undefined, tabIds: Set<number>}>} */
  const groups = new Map();
  /** @type {Map<number, number>} tabId -> groupId */
  const tabToGroup = new Map();

  const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
  const nativeGet = chrome.tabs.get.bind(chrome.tabs);

  function save() {
    try {
      const serialised = [...groups].map(([id, g]) => ({ ...g, id, tabIds: [...g.tabIds] }));
      return chrome.storage.session.set({ [STORE_KEY]: { nextGroupId, groups: serialised } });
    } catch {
      return Promise.resolve();
    }
  }

  const ready = (async () => {
    try {
      const saved = (await chrome.storage.session.get(STORE_KEY))[STORE_KEY];
      if (!saved) return;
      if (saved.nextGroupId) nextGroupId = saved.nextGroupId;
      for (const g of saved.groups || []) {
        groups.set(g.id, { ...g, tabIds: new Set(g.tabIds) });
        for (const tabId of g.tabIds) tabToGroup.set(tabId, g.id);
      }
    } catch {
      // storage.session unavailable - stay in-memory only
    }
  })();

  function groupObj(id) {
    const g = groups.get(id);
    if (!g) throw new Error(`No group with id ${id}`);
    return {
      id,
      title: g.title || '',
      color: g.color || 'grey',
      collapsed: Boolean(g.collapsed),
      windowId: g.windowId,
    };
  }

  chrome.tabs.group = async function group(options = {}) {
    await ready;
    const tabIds = [].concat(options.tabIds || []);
    let groupId = options.groupId;
    let windowId = options.createProperties && options.createProperties.windowId;

    if (groupId == null || !groups.has(groupId)) {
      if (groupId == null) groupId = nextGroupId++;
      if (windowId == null && tabIds.length) {
        try {
          windowId = (await nativeGet(tabIds[0])).windowId;
        } catch {
          // tab already gone; leave windowId undefined
        }
      }
      groups.set(groupId, { title: '', color: 'grey', collapsed: false, windowId, tabIds: new Set() });
    }

    const g = groups.get(groupId);
    for (const tabId of tabIds) {
      g.tabIds.add(tabId);
      tabToGroup.set(tabId, groupId);
    }
    await save();
    return groupId;
  };

  chrome.tabs.ungroup = async function ungroup(tabIds) {
    await ready;
    for (const tabId of [].concat(tabIds || [])) {
      const groupId = tabToGroup.get(tabId);
      if (groupId == null) continue;
      const g = groups.get(groupId);
      if (g) g.tabIds.delete(tabId);
      tabToGroup.delete(tabId);
    }
    await save();
  };

  async function queryWithGroups(queryInfo) {
    await ready;
    if (!queryInfo || queryInfo.groupId == null) return nativeQuery(queryInfo);

    const { groupId } = queryInfo;
    if (groups.has(groupId)) {
      const g = groups.get(groupId);
      const out = [];
      for (const tabId of [...g.tabIds]) {
        try {
          const tab = await nativeGet(tabId);
          tab.groupId = groupId;
          out.push(tab);
        } catch {
          g.tabIds.delete(tabId);
          tabToGroup.delete(tabId);
        }
      }
      return out;
    }

    // Unknown group id: fall back to a native query with the filter removed,
    // then apply our own membership tracking.
    const rest = { ...queryInfo };
    delete rest.groupId;
    const tabs = await nativeQuery(rest);
    return tabs.filter((tab) => tabToGroup.get(tab.id) === groupId);
  }

  chrome.tabs.query = function query(queryInfo, callback) {
    const promise = queryWithGroups(queryInfo);
    if (typeof callback !== 'function') return promise;
    promise.then(callback, () => callback([]));
    return undefined;
  };

  chrome.tabs.get = function get(tabId, callback) {
    const promise = (async () => {
      const tab = await nativeGet(tabId);
      const groupId = tabToGroup.get(tabId);
      if (groupId != null) tab.groupId = groupId;
      else if (tab.groupId == null) tab.groupId = NONE;
      return tab;
    })();
    if (typeof callback !== 'function') return promise;
    promise.then(callback, () => callback(undefined));
    return undefined;
  };

  // Override chrome.tabGroups methods in place: the native namespace object is
  // usually present but not replaceable.
  let tabGroups = chrome.tabGroups;
  if (!tabGroups) {
    try {
      chrome.tabGroups = {};
      tabGroups = chrome.tabGroups;
    } catch {
      tabGroups = globalThis.__arcTabGroups = {};
    }
  }

  function set(key, value) {
    try {
      tabGroups[key] = value;
    } catch {
      try {
        Object.defineProperty(tabGroups, key, { value, writable: true, configurable: true });
      } catch {
        console.error('[arc-sidepanel-api] could not install chrome.tabGroups.%s', key);
      }
    }
  }

  set('get', async (id) => {
    await ready;
    return groupObj(id);
  });

  set('query', async (queryInfo) => {
    await ready;
    return [...groups.keys()]
      .map(groupObj)
      .filter((g) =>
        !queryInfo ||
        (['windowId', 'color', 'title', 'collapsed'].every(
          (k) => queryInfo[k] == null || g[k] === queryInfo[k]
        ))
      );
  });

  set('update', async (id, props) => {
    await ready;
    const g = groups.get(id);
    if (!g) throw new Error(`No group with id ${id}`);
    for (const key of ['title', 'color', 'collapsed']) {
      if (props && props[key] != null) g[key] = props[key];
    }
    await save();
    return groupObj(id);
  });

  // Arc has no group UI to move, so this is a no-op that reports success.
  set('move', async (id) => {
    await ready;
    return groupObj(id);
  });

  if (typeof tabGroups.TAB_GROUP_ID_NONE === 'undefined') set('TAB_GROUP_ID_NONE', NONE);
  if (!tabGroups.Color) set('Color', Color);
  for (const event of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
    if (!tabGroups[event]) set(event, { addListener() {}, removeListener() {} });
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    const groupId = tabToGroup.get(tabId);
    if (groupId == null) return;
    const g = groups.get(groupId);
    if (g) g.tabIds.delete(tabId);
    tabToGroup.delete(tabId);
    save();
  });
}
