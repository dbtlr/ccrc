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

# The agent resolves CCRC_CONFIG on its own, from launchd's working directory — a
# relative path that happens to work here would restart-loop there. Pin it down now.
case "${config}" in
/*) ;;
*)
  if [ ! -f "${config}" ]; then
    echo "no ccrcd config at ${config} (relative to $(pwd)); create it (or set CCRC_CONFIG) first" >&2
    exit 1
  fi
  config="$(cd "$(dirname "${config}")" && pwd -P)/$(basename "${config}")"
  ;;
esac

bun="$(command -v bun || true)"
if [ -z "${bun}" ]; then
  echo "bun is not on PATH; install it first: https://bun.sh" >&2
  exit 1
fi
# command -v echoes whatever spelling found the binary; ProgramArguments needs an
# absolute path, since launchd starts the job from its own working directory.
bun="$(cd "$(dirname "${bun}")" && pwd -P)/$(basename "${bun}")"

# The agent runs with the PATH captured here and inherits nothing else. Relative
# entries would resolve against launchd's working directory, so only absolute ones
# are baked in — and the tools ccrcd shells out to have to be findable among them.
# Otherwise the daemon comes up, reports itself unwell, and fails every launch.
agent_path=""
IFS=':' read -ra path_entries <<<"${PATH}"
for entry in "${path_entries[@]}"; do
  case "${entry}" in
  /*) agent_path="${agent_path:+${agent_path}:}${entry}" ;;
  esac
done
for tool in tmux claude; do
  if ! PATH="${agent_path}" command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} is not on PATH; ccrcd runs every session through it" >&2
    exit 1
  fi
done

# A missing config is a fatal startup error, and KeepAlive would turn that into a
# restart loop — and the agent runs as this same user, so a config this shell cannot
# read is one the daemon cannot read either. Refuse the install instead.
if [ ! -f "${config}" ] || [ ! -r "${config}" ]; then
  echo "ccrcd config at ${config} is missing or unreadable; create it (or set CCRC_CONFIG) first" >&2
  exit 1
fi

mkdir -p "${agents_dir}" "${log_dir}"

# Staged first: writing straight to the plist would truncate a working agent's
# definition before knowing whether this render even succeeds. Staged beside the
# destination so the final rename stays on one filesystem (launchd only scans for
# *.plist, so the dotfile staging name is never picked up).
staged="$(mktemp "${agents_dir}/.${label}.XXXXXX")"
trap 'rm -f "${staged}"' EXIT

CCRC_TEMPLATE="${template}" \
  CCRC_LABEL="${label}" \
  CCRC_BUN="${bun}" \
  CCRC_REPO_DIR="${repo_dir}" \
  CCRC_HOME_DIR="${HOME}" \
  CCRC_AGENT_PATH="${agent_path}" \
  CCRC_CONFIG_PATH="${config}" \
  CCRC_LOG_DIR="${log_dir}" \
  bash "${here}/render-plist.sh" >"${staged}"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "${staged}" >/dev/null
fi

mv "${staged}" "${plist}"
trap - EXIT

domain="gui/$(id -u)"
launchctl bootout "${domain}/${label}" 2>/dev/null || true
launchctl bootstrap "${domain}" "${plist}"

echo "installed ${label}"
echo "  plist:  ${plist}"
echo "  config: ${config}"
echo "  logs:   ${log_dir}/ccrcd.out.log and ${log_dir}/ccrcd.err.log"
echo "  remove: ${here}/uninstall.sh"
