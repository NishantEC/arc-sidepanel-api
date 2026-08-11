# arc-sidepanel-api

Arc browser doesn't implement `chrome.sidePanel`, so any Chrome extension that
uses it (Claude, CSS Peeper, and many others) silently breaks - the icon
click does nothing, because Arc has no side panel surface for extensions to
render into and has said it doesn't plan to add one.

This project patches those extensions so they work anyway, via a floating
docked panel instead of a native side panel, and gives you a settings-page UI
inside Arc to do it with one click instead of hand-editing files.

## Panel styles

Pick one per extension when you patch it:

- **Overlay** (default) - a docked iframe drawn on the page. Works on any page
  a content script can reach, follows you between tabs, costs no tab. But it
  lives in the page's DOM, so navigating away closes it, and a site with a
  strict `frame-src` CSP can block it.
- **Split tab** - the panel page opened as a real browser tab. Drag it into an
  Arc split once and Arc remembers the layout per space. It survives
  navigation, resizes with Arc's own divider, and no page CSP can touch it.
  Costs a tab, and needs that one manual drag.

Arc's Split View is native Arc UI with no extension API behind it, so nothing
here can trigger the split for you - split-tab mode just gives Arc a real tab
to split with.

## How it works

Three pieces:

- **`packages/core`** - the patch engine. Given any installed extension, it
  detects `chrome.sidePanel` usage from the manifest, copies the extension
  (never touching the original), and injects:
  - a service worker shim that intercepts `chrome.sidePanel.*` calls and
    routes them to whichever panel style you chose
  - **overlay mode**: a content script that renders the docked, closable
    iframe, plus a `web_accessible_resources` entry for the side panel page -
    without which the browser blocks the iframe outright (extensions that only
    ever used the native side panel have no reason to declare one)
  - **split-tab mode**: a script injected into the side panel page that keeps
    `chrome.tabs.query({active: true, ...})` resolving to the tab in the other
    pane, since the panel is now a tab itself and would otherwise answer with
    its own id. The `tabId` query param is stripped from the panel URL for the
    same reason - extensions read it once at mount, which goes stale the moment
    you navigate the other pane
  - a keyboard shortcut, but only if a chord is free - Chrome silently drops a
    `suggested_key` that collides with one the extension already declares. The
    extension's own shortcut is made to toggle rather than only open, matching
    what the native side panel does
  - an in-memory `chrome.tabGroups` emulation, for extensions that declare the
    `tabGroups` permission. Arc exposes the tab-groups API but
    `chrome.tabs.group()` never settles, so anything routed through it hangs
    forever rather than failing
- **`packages/native-host`** - a small Node process registered as a
  [Chrome Native Messaging host](https://developer.chrome.com/docs/apps/nativeMessaging/).
  This is the only piece with filesystem access - it's what actually reads
  Arc's installed-extensions folder and writes patched copies. No browser
  extension can do this on its own; it's a deliberate Chromium security
  boundary.
- **`packages/extension`** - a settings-page UI, loaded into Arc via
  Developer Mode, that lists your installed extensions, flags which ones use
  `chrome.sidePanel`, and gives you a "Patch" button per extension.

Why this needs a native host and not just an extension: browser extensions
are sandboxed from the filesystem and from each other, and no extension can
silently install another extension into Arc - Chromium disallows that
outright, for anyone, regardless of permissions. The one manual step you
can't avoid: after patching, you click "Load Unpacked" in `arc://extensions`
yourself.

**Any installed extension can be patched, packed or not.** Chromium always
unpacks a `.crx` to plain files on disk to run it - "packed" only describes
the distribution format, not the local source's accessibility. What you lose
by patching: automatic updates (re-run the patch after Arc updates the
original), and possibly the extension's ID if its manifest didn't happen to
pin a signing key (only matters if some page does a strict
`chrome-extension://<id>/` origin check).

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
4. Click Patch, then "Reveal in Finder" - Load that revealed folder the same
   way via "Load Unpacked", and disable the original extension so you're not
   running both

## Limitations

- **macOS only.** Arc's native-messaging host search path isn't publicly
  documented; the installer writes to both plausible locations. Windows/Linux
  support is open for contribution.
- **MV3 extensions with a background service worker only.** An extension
  that calls `chrome.sidePanel` only from a content script (no
  `background.service_worker`) isn't supported yet.
- **No auto-update.** A patched, unpacked copy doesn't pull updates from the
  Chrome Web Store. Re-run the patch against the newer installed version when
  you want to update.
- **Overlay mode: sites with a strict `frame-src` CSP.** The panel is an
  iframe on the host page, so a page whose Content-Security-Policy forbids
  `chrome-extension:` frames won't show it. Use split-tab mode there.
- **Overlay mode: the panel closes on navigation.** It lives in the page's
  DOM, so a page load takes it with it. Split-tab mode doesn't have this
  problem.
- **Cosmetic isolation, not pixel-perfect.** The overlay panel resets most
  inherited page styles but isn't rendered in a Shadow DOM yet, so pages with
  unusual global CSS could still leak into it occasionally.
- **The extension ID for allowed_origins is hardcoded** to the key checked
  into `packages/extension/manifest.json`. If you fork this and change that
  key, regenerate it with `node scripts/generate-extension-key.js` and update
  `EXTENSION_ID` in `packages/native-host/install.sh` to match.

## Development

```sh
npm install
npm test    # runs packages/core and packages/native-host unit tests
```

## Credit

The floating-panel + service-worker-shim approach that makes this whole
project not need Arc binary patching was validated first by
[quardianwolf/claude-arc-patch](https://github.com/quardianwolf/claude-arc-patch),
which did it for the Claude extension specifically. This project generalizes
that pattern to any extension, with a settings-page UI on top.

## License

MIT
