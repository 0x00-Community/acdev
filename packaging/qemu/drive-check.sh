#!/bin/sh
# Checks that drive.sh prints a non-ASCII answer byte for byte under dash and bash (#108: dash 0.5.13 put 0x81 before
# UTF-8 continuation bytes that went through $(...) / printf). No session needed: a stand-in for the Broker's
# ACDE_DEBUG_DIR watcher answers drive.sh's module with a fixed JSON file. Shells that are not installed are skipped,
# but dash must be there. Exit 0 when every shell printed the answer unchanged.
#   drive-check.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# the answer: "文本编辑 丁ā" as octal bytes (continuation bytes 0x81, 0x87, 0x96 among them, the ones dash mangled)
printf '{\n  "title": "\346\226\207\346\234\254\347\274\226\350\276\221 \344\270\201\304\201"\n}' >"$work/answer"
{ cat "$work/answer"; echo; } >"$work/expected"
# what the Broker does with each *.mjs in ACDE_DEBUG_DIR: write <name>.out, rename the module to <name>.mjs.done
broker() {
	tries=0
	while [ "$tries" -lt 100 ]; do
		for module in "$work"/debug/*.mjs; do
			[ -f "$module" ] || continue
			cp "$work/answer" "${module%.mjs}.out"
			mv "$module" "$module.done"
			return 0
		done
		sleep 0.1
		tries=$((tries + 1))
	done
	return 1
}
command -v dash >/dev/null || { echo "drive-check.sh: dash is not installed" >&2; exit 1; }
failed=0
for shell in dash bash; do
	command -v "$shell" >/dev/null || { echo "skip $shell: not installed"; continue; }
	rm -rf "$work/debug"
	mkdir "$work/debug"
	broker &
	"$shell" "$here/drive.sh" -d "$work/debug" -t 10 windows >"$work/got" || true
	wait "$!" || true
	if cmp -s "$work/expected" "$work/got"; then
		echo "ok   $shell"
	else
		echo "FAIL $shell: drive.sh's output differs from the answer" >&2
		od -An -tx1 "$work/got" >&2
		failed=1
	fi
done
exit "$failed"
