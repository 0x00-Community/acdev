#!/usr/bin/env dash
# Drive a running acde session from a shell on the same machine: hands drive.mjs's command line (see there) to the
# session's Broker through its ACDE_DEBUG_DIR and prints the answer (JSON). The session must have been started with
# ACDE_DEBUG_DIR set; this script needs that directory in its own environment (or -d DIR) and drive.mjs next to it.
#   drive.sh [-d DIR] [-t SECONDS] COMMAND [ARGS...]     -t: how long to wait for the answer (default 120)
#   drive.sh perf drag 10 files        drive.sh eval desktop 'document.title'        drive.sh keys ctrl+space
set -eu
dir=${ACDE_DEBUG_DIR:-}
timeout=120
while [ $# -gt 0 ]; do
	case "$1" in
	-d) dir=$2; shift 2 ;;
	-t) timeout=$2; shift 2 ;;
	*) break ;;
	esac
done
[ -n "$dir" ] || { echo "drive.sh: no ACDE_DEBUG_DIR (or -d DIR)" >&2; exit 2; }
[ $# -gt 0 ] || { echo "usage: drive.sh [-d DIR] [-t SECONDS] COMMAND [ARGS...]" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
name=drive-$$-$(date +%s)
# the arguments NUL-separated in a file of their own (any text, newlines included), read back by the module
for arg; do printf '%s\0' "$arg"; done >"$dir/$name.args"
# written under another name first: the Broker picks up every *.mjs it finds
cat >"$dir/$name.tmp" <<EOF
import { run } from 'file://$here/drive.mjs'
export default (api) => run(api, api.readText('$dir/$name.args').split('\0').slice(0, -1))
EOF
mv "$dir/$name.tmp" "$dir/$name.mjs"
waited=0
until [ -f "$dir/$name.out" ]; do
	if [ "$waited" -ge $((timeout * 10)) ]; then
		echo "drive.sh: no answer from the session in ${timeout}s (is it running with ACDE_DEBUG_DIR=$dir?)" >&2
		rm -f "$dir/$name.mjs" "$dir/$name.args"
		exit 1
	fi
	sleep 0.1
	waited=$((waited + 1))
done
# the answer straight from the file: dash 0.5.13 corrupts UTF-8 that passes through $(...) and printf (it puts 0x81
# before some continuation bytes), so it never goes through a variable
status=0
cat "$dir/$name.out"
echo
! grep -qF '"error":' "$dir/$name.out" || status=1
rm -f "$dir/$name.out" "$dir/$name.mjs.done" "$dir/$name.args"
exit "$status"
