# arc-sidepanel-api

Arc browser doesn't implement `chrome.sidePanel`, so any Chrome extension that
relies on it (Claude and many others) silently breaks - the icon click does
nothing, because Arc has no side panel surface for extensions to render into
and has said it doesn't plan to add one.

This project patches those extensions so they work anyway, and gives you a
settings-page UI inside Arc to do it with one click instead of hand-editing
files.

## Check before you patch

Some extensions ship *two* sidebars: the native `chrome.sidePanel` one and
their own, rendered straight into the page. Sider and CSS Peeper both do this,
and their in-page version already works in Arc untouched - patching them
usually just swaps a maintained UI for ours.

The patcher detects this and says so before offering to patch. Look for the
extension's own display-mode setting first. See
[Detecting extensions that don't need patching](#detecting-extensions-that-dont-need-patching).

## Panel styles

Pick one per extension when you patch it:

- **Overlay** (default) - the panel is docked to the right and the page is
  squeezed to fit beside it, the way a native side panel narrows the viewport.
  Drag its left edge to resize; the width persists. Works on any page a content
  script can reach and follows you between tabs.
- **Split tab** - the panel page opened as a real browser tab. Drag it into an
  Arc split once and Arc remembers the layout per space. Resizes with Arc's own
  divider and no page CSP can touch it. Costs a tab, and needs that one manual
  drag.

Arc's Split View is native Arc UI with no extension API behind it, so nothing
here can trigger the split for you - split-tab mode just gives Arc a real tab
to split with.

## How it works

Three pieces:

- **`packages/core`** - the patch engine. Given any installed extension, it
  detects `chrome.sidePanel` usage from the manifest, copies the extension
  (never touching the original), and injects a service worker shim that
  intercepts `chrome.sidePanel.*` calls and routes them to whichever panel
  style you chose.
- **`packages/native-host`** - a small Node process registered as a
  [Chrome Native Messaging host](https://developer.chrome.com/docs/apps/nativeMessaging/).
  This is the only piece with filesystem access - it's what actually reads
  Arc's installed-extensions folder and writes patched copies. No browser
  extension can do this on its own; it's a deliberate Chromium security
  boundary.
- **`packages/extension`** - a settings-page UI, loaded into Arc via Developer
  Mode, that lists your installed extensions, flags which ones use
  `chrome.sidePanel`, warns about the ones that already have their own in-page
  panel, and gives you a panel-style picker and a "Patch" button per extension.

Why this needs a native host and not just an extension: browser extensions are
sandboxed from the filesystem and from each other, and no extension can
silently install another extension into Arc - Chromium disallows that outright,
for anyone, regardless of permissions. The one manual step you can't avoid:
after patching, you click "Load Unpacked" in `arc://extensions` yourself.

**Any installed extension can be patched, packed or not.** Chromium always
unpacks a `.crx` to plain files on disk to run it - "packed" only describes the
distribution format, not the local source's accessibility.

### What the patch actually changes

The extension's own code is never edited. `background.service_worker` is
repointed at a generated entry that imports the shims before the original
worker, so bundling and minification are irrelevant.

- **`web_accessible_resources` for the side panel page and the extension's
  icons.** Without this the browser blocks the panel iframe outright and the
  title bar icon renders broken. Extensions that only ever used the native side
  panel have no reason to declare either.
- **Overlay mode**: a content script that renders the panel in a shadow root
  (page CSS can't reach into one - an inline style still loses to a page rule
  carrying `!important`) and squeezes `<html>` to make room. The service worker
  remembers which tabs have a panel open, so it comes back after a navigation
  rather than vanishing.
- **Split-tab mode**: a script injected into the side panel page keeping
  `chrome.tabs.query({active: true, ...})` resolved to the tab in the other
  pane, since the panel is a tab itself and would otherwise answer with its own
  id. The same substitution is applied in the service worker, which is where
  extensions usually ask. The `tabId` query param is stripped from the panel
  URL for the same reason - extensions read it once at mount, which goes stale
  the moment you navigate the other pane.
- **A keyboard shortcut**, but only if a chord is free - Chrome silently drops
  a `suggested_key` that collides with one the extension already declares. The
  extension's own shortcut is made to toggle rather than only open, matching
  the native side panel.
- **An in-memory `chrome.tabGroups` emulation**, for extensions declaring the
  `tabGroups` permission. Arc exposes the tab-groups API but
  `chrome.tabs.group()` never settles, so anything routed through it hangs
  forever rather than failing.

`chrome.sidePanel` methods are installed one at a time rather than by replacing
the namespace: on some builds it's a non-writable accessor, and assigning to it
under `'use strict'` throws, which would abort the shim and take the
extension's own service worker down with it.

### Detecting extensions that don't need patching

Extensions render their own in-page panel in one of two shapes, so the
detector looks for both:

| shape | signal | example |
| --- | --- | --- |
| Embeds its own page in an iframe | a content script running on every page names a panel-shaped `.html` file the extension actually ships | Sider embeds `sidepanel.html` |
| Renders directly in JS | a content script running on every page builds a shadow root and is far too large to be decorating one | CSS Peeper's 1.6MB inspector |

The size threshold isn't load-bearing: Claude's in-page agent indicator also
uses a shadow root but is 18KB, against CSS Peeper's 1615KB. Anything between
100KB and 1.5MB gives the same verdicts.

This is a heuristic over minified bundles, so it's advisory - it warns, and
never refuses to patch. It deliberately ignores `web_accessible_resources`,
because patching adds the panel page there and a patched copy would otherwise
flag itself.

## Install

macOS only for now (Windows/Linux Arc native-messaging paths aren't wired up
yet - see [Limitations](#limitations)).

```sh
git clone https://github.com/NishantEC/arc-sidepanel-api.git
cd arc-sidepanel-api
npm install
./packages/native-host/install.sh
```

Then in Arc:

1. Go to `arc://extensions`, enable Developer Mode
2. Click "Load Unpacked", select `packages/extension/`
3. Click the extension's toolbar icon - it opens a settings page listing your
   installed extensions, with a "Patch" button on any that use
   `chrome.sidePanel`
4. Pick a panel style, click Patch, then "Reveal in Finder" - Load that
   revealed folder the same way via "Load Unpacked", and disable the original
   extension so you're not running both

**After reloading a patched extension, reload any pages you had open.** Their
content scripts and panel iframes belong to the previous instance and stop
working - the panel detects this and cleans itself up, but only a page reload
brings it back.

## Limitations

- **macOS only.** Arc's native-messaging host search path isn't publicly
  documented; the installer writes to both plausible locations. Windows/Linux
  support is open for contribution.
- **MV3 extensions with a background service worker only.** An extension that
  calls `chrome.sidePanel` only from a content script (no
  `background.service_worker`) isn't supported yet.
- **No auto-update.** A patched, unpacked copy doesn't pull updates from the
  Chrome Web Store. Re-run the patch against the newer installed version when
  you want to update. Patch the *original* - the patcher refuses to patch a
  patched copy, which would otherwise generate a service worker that imports
  itself.
- **Overlay mode: the page's own fixed elements aren't squeezed.** Sticky
  headers and floating widgets resolve against the viewport, not `<html>`, so
  the panel still covers their right edge. Constraining them would mean putting
  a `transform` on `<html>`, which would also capture the panel and break its
  positioning.
- **Overlay mode: two scrollbars.** The page's scrollbar sits in the viewport's
  gutter, to the right of the panel, alongside the panel's own. Moving it
  beside the panel would mean making `<body>` the scroll container, which stops
  `window` scroll events firing and breaks lazy-loading and scroll-spy on many
  sites.
- **Overlay mode: sites with a strict `frame-src` CSP.** The panel is an iframe
  on the host page, so a page whose Content-Security-Policy forbids
  `chrome-extension:` frames won't show it. Use split-tab mode there.
- **The extension ID for allowed_origins is hardcoded** to the key checked into
  `packages/extension/manifest.json`. If you fork this and change that key,
  regenerate it with `node scripts/generate-extension-key.js` and update
  `EXTENSION_ID` in `packages/native-host/install.sh` to match.

Patched copies keep their original extension ID whenever the source manifest
pins a signing `key`, which store-installed extensions do. That matters for
`chrome.identity` OAuth redirects and `externally_connectable` handshakes,
which are bound to the ID - but it also means you must remove the original
before loading the patched copy, since the two collide.

## Development

```sh
npm install
npm test    # packages/core and packages/native-host unit tests
npm run lint
```

`npm run lint` syntax-checks the injected templates in
`packages/core/templates/` as well as the Node sources. Those templates run in
the browser rather than under Node, so they have no unit tests - the patcher
tests assert that they're installed and wired up correctly, not what they do at
runtime.

## Credit

The panel + service-worker-shim approach that makes this whole project not need
Arc binary patching was validated first by
[quardianwolf/claude-arc-patch](https://github.com/quardianwolf/claude-arc-patch),
which did it for the Claude extension specifically. This project generalizes
that pattern to any extension, with a settings-page UI on top.

## License

MIT
