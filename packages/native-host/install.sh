#!/usr/bin/env bash
set -euo pipefail

# Registers the arc-sidebar-api native messaging host so the browser
# extension can ask it to read/patch installed extensions on disk.
# macOS only for now - see README for the Windows/Linux tracking issue.

HOST_NAME="com.arc_sidebar_api.host"
# Must match the ID derived from the "key" pinned in packages/extension/manifest.json
# (see scripts/generate-extension-key.js for how that pairing works).
EXTENSION_ID="gpconahgokadiigbigonmlelgihbecel"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_ENTRY="$SCRIPT_DIR/src/index.js"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this installer only supports macOS right now." >&2
  echo "Windows/Linux Arc native-messaging paths are tracked in the README - contributions welcome." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node was not found on PATH. Install Node.js 18+ first." >&2
  exit 1
fi

chmod +x "$HOST_ENTRY"

MANIFEST_JSON=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "arc-sidebar-api native host - patches chrome.sidePanel usage into Arc-compatible extensions",
  "path": "$HOST_ENTRY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
)

# Arc's on-disk layout (~/Library/Application Support/Arc/User Data/Default/...)
# doesn't exactly match Chrome's (~/Library/Application Support/Google/Chrome/Default/...)
# or Brave's, and Arc's native-messaging search path isn't publicly documented.
# We write to both plausible locations, following the convention every other
# Chromium browser uses (a NativeMessagingHosts folder next to the "Default"
# profile's parent) - harmless if one of them turns out to be unused.
CANDIDATE_DIRS=(
  "$HOME/Library/Application Support/Arc/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
)

for dir in "${CANDIDATE_DIRS[@]}"; do
  mkdir -p "$dir"
  printf '%s' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
  echo "Registered host manifest at: $dir/$HOST_NAME.json"
done

echo ""
echo "Native host installed. Next steps:"
echo "  1. Load packages/extension/ in Arc via arc://extensions -> Load Unpacked"
echo "  2. Open the extension's settings page to list and patch installed extensions"
echo ""
echo "If the extension reports it can't reach the native host, please open an issue"
echo "with your Arc version - one of the two candidate paths above may be wrong."
