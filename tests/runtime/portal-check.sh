#!/usr/bin/env dash
# Run portal-check.mjs under acde on a private D-Bus session bus without service files (an installed
# xdg-desktop-portal is not activated), in a fresh directory under $ACDE_CHECK_TMP (default: $TMPDIR, else /tmp).
# Usage: tests/runtime/portal-check.sh <acde binary>
set -eu
acde=$(realpath "$1")
here=$(dirname "$(realpath "$0")")
dir=$(mktemp -d "${ACDE_CHECK_TMP:-${TMPDIR:-/tmp}}/acde-portal.XXXXXX")
trap 'rm -rf "$dir"' EXIT
cat > "$dir/bus.conf" <<CONF
<busconfig><type>session</type><listen>unix:dir=$dir</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
CONF
dbus-run-session --config-file="$dir/bus.conf" -- "$acde" run "$here/portal-check.mjs"
