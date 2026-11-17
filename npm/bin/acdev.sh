#!/bin/sh
self=$0
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
bin=$(cd -P "$(dirname "$self")" && pwd -P) || exit 1
cli=$(dirname "$bin")/lib/acdev/dist/cli.js
at_least() {
  major=${1%%.*}
  minor=0
  case $1 in
    *.*) minor=${1#*.} && minor=${minor%%.*} ;;
  esac
  case $major$minor in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -gt "$2" ] || { [ "$major" -eq "$2" ] && [ "$minor" -ge "$3" ]; }
}
cache=$(dirname "$bin")/lib/runtime-cache
bun=$(command -v bun 2>/dev/null) || bun=
node=$(command -v node 2>/dev/null) || node=
key="bun $bun	node $node"
fresh() {
  [ -z "$1" ] || [ ! "$1" -nt "$cache" ]
}
if [ -f "$cache" ] && fresh "$bun" && fresh "$node"; then
  { IFS= read -r cached_key && IFS= read -r chosen; } <"$cache" 2>/dev/null || cached_key=
  if [ "$cached_key" = "$key" ] && [ -n "$chosen" ] && [ -x "$chosen" ]; then
    exec "$chosen" "$cli" "$@"
  fi
fi
remember() {
  { printf '%s\n%s\n' "$key" "$1" >"$cache"; } 2>/dev/null || :
}
bun_version=
node_version=
if [ -n "$bun" ]; then
  bun_version=$("$bun" --version 2>/dev/null)
  if at_least "$bun_version" 1 4; then
    remember "$bun"
    exec "$bun" "$cli" "$@"
  fi
fi
if [ -n "$node" ]; then
  node_version=$("$node" -p "process.versions.bun ? '' : process.versions.node" 2>/dev/null)
  if at_least "$node_version" 22 3; then
    remember "$node"
    exec "$node" "$cli" "$@"
  fi
fi
if [ -n "$bun_version" ]; then
  echo "acdev: needs Bun 1.4 or newer, and the bun on PATH is $bun_version:" \
    "update it (bun upgrade, or https://bun.sh)" >&2
  exit 1
fi
if [ -n "$node_version" ]; then
  echo "acdev: needs Node.js 22.3 or newer, and the node on PATH is $node_version: update it (https://nodejs.org)" >&2
  exit 1
fi
echo "acdev: needs Bun 1.4+ or Node.js 22.3+ and there is neither on PATH:" \
  "install one of them, Bun (https://bun.sh) or Node.js (https://nodejs.org)" >&2
exit 1
