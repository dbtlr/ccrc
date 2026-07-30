#!/usr/bin/env bash
# Renders the LaunchAgent plist to stdout, substituting host values into the
# template. Split out from install.sh so the substitution can be tested against
# awkward paths without loading anything into launchd.
#
# Substitution is bash parameter expansion rather than sed, and every value is
# XML-escaped. Both matter: `&`, `|`, `<` and `>` are all legal in a macOS path, an
# unescaped `&` in a sed replacement is "the text that matched", a `|` ends the
# s-command, and a plist is XML. Any of those either breaks the install outright or —
# worse — writes a plist that parses cleanly and names a program that does not exist,
# which KeepAlive turns into a crash loop.
#
# Inputs are environment variables so nothing depends on argument order.
set -euo pipefail

: "${CCRC_TEMPLATE:?CCRC_TEMPLATE is required}"
: "${CCRC_LABEL:?CCRC_LABEL is required}"
: "${CCRC_BUN:?CCRC_BUN is required}"
: "${CCRC_REPO_DIR:?CCRC_REPO_DIR is required}"
: "${CCRC_HOME_DIR:?CCRC_HOME_DIR is required}"
: "${CCRC_AGENT_PATH:?CCRC_AGENT_PATH is required}"
: "${CCRC_CONFIG_PATH:?CCRC_CONFIG_PATH is required}"
: "${CCRC_LOG_DIR:?CCRC_LOG_DIR is required}"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "${value}"
}

contents="$(cat "${CCRC_TEMPLATE}")"
contents="${contents//__LABEL__/$(xml_escape "${CCRC_LABEL}")}"
contents="${contents//__BUN__/$(xml_escape "${CCRC_BUN}")}"
contents="${contents//__REPO_DIR__/$(xml_escape "${CCRC_REPO_DIR}")}"
contents="${contents//__HOME__/$(xml_escape "${CCRC_HOME_DIR}")}"
contents="${contents//__PATH__/$(xml_escape "${CCRC_AGENT_PATH}")}"
contents="${contents//__CONFIG__/$(xml_escape "${CCRC_CONFIG_PATH}")}"
contents="${contents//__LOG_DIR__/$(xml_escape "${CCRC_LOG_DIR}")}"

if [[ "${contents}" =~ __[A-Z_]+__ ]]; then
  echo "the rendered plist still has an unsubstituted marker; refusing to install it" >&2
  exit 1
fi

printf '%s\n' "${contents}"
