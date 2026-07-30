#!/usr/bin/env bash
# Installs ccrcd as a per-user LaunchAgent: started at login, restarted if it exits.
#
# Every host-specific value is resolved here rather than committed — the bun on
# PATH, the checkout this script lives in, and the invoking user's home, PATH, and
# config location.
set -euo pipefail

label="dev.ccrc.ccrcd"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${here}/../.." && pwd)"
template="${here}/${label}.plist.template"
agents_dir="${HOME}/Library/LaunchAgents"
plist="${agents_dir}/${label}.plist"
log_dir="${HOME}/Library/Logs/ccrc"
config="${CCRC_CONFIG:-${HOME}/.config/ccrc/config.toml}"

bun="$(command -v bun || true)"
if [ -z "${bun}" ]; then
  echo "bun is not on PATH; install it first: https://bun.sh" >&2
  exit 1
fi

# A missing config is a fatal startup error, and KeepAlive would turn that into a
# restart loop. Refuse the install instead.
if [ ! -f "${config}" ]; then
  echo "no ccrcd config at ${config}; create it (or set CCRC_CONFIG) first" >&2
  exit 1
fi

mkdir -p "${agents_dir}" "${log_dir}"

sed \
  -e "s|__LABEL__|${label}|g" \
  -e "s|__BUN__|${bun}|g" \
  -e "s|__REPO_DIR__|${repo_dir}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__PATH__|${PATH}|g" \
  -e "s|__CONFIG__|${config}|g" \
  -e "s|__LOG_DIR__|${log_dir}|g" \
  "${template}" >"${plist}"

domain="gui/$(id -u)"
launchctl bootout "${domain}/${label}" 2>/dev/null || true
launchctl bootstrap "${domain}" "${plist}"

echo "installed ${label}"
echo "  plist:  ${plist}"
echo "  config: ${config}"
echo "  logs:   ${log_dir}/ccrcd.out.log and ${log_dir}/ccrcd.err.log"
echo "  remove: ${here}/uninstall.sh"
