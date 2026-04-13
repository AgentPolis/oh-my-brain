#!/bin/zsh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_PATH="$(which node)"
HOME_DIR="$HOME"
PLIST_SRC="$REPO_ROOT/ops/com.agentpolis.squeeze-codex-sync.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.agentpolis.squeeze-codex-sync.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/.codex/memories"
sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/com.agentpolis.squeeze-codex-sync" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/com.agentpolis.squeeze-codex-sync"

echo "Installed and started com.agentpolis.squeeze-codex-sync"
