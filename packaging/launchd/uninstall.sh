#!/usr/bin/env bash
# Removes the ccrcd LaunchAgent. Sessions it started keep running under tmux —
# stop them through the API if that is not what you want.
set -euo pipefail

label="dev.ccrc.ccrcd"
plist="${HOME}/Library/LaunchAgents/${label}.plist"

launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
rm -f "${plist}"

echo "removed ${label} (logs under ${HOME}/Library/Logs/ccrc are left in place)"
