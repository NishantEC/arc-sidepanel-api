# arc-sidebar-api

Arc browser doesn't implement `chrome.sidePanel`, so any Chrome extension that
uses it (Claude, CSS Peeper, and many others) silently breaks - the icon
click does nothing, because Arc has no sidebar surface for extensions to
render into and has said it doesn't plan to add one.

This project patches those extensions so they work anyway, via a floating
docked panel instead of a native side panel, and gives you a settings-page UI
inside Arc to do it with one click instead of hand-editing files.

## How it works

Three pieces:

- **`packages/core`** - the patch engine. Given any installed extension, it
  detects `chrome.sidePanel` usage from the manifest, copies the extension
  (never touching the original), and injects:
  - a content script that renders a docked, closable iframe panel on the page
  - a service worker shim that intercepts `chrome.sidePanel.*` calls and
    routes them to that panel
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
git clone https://github.com/NishantEC/arc-sidebar-api.git
cd arc-sidebar-api
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
- **Cosmetic isolation, not pixel-perfect.** The floating panel resets most
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
