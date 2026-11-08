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
cli=$(dirname "$bin")/lib/acde/src/cli.js
if command -v bun >/dev/null 2>&1; then
  exec bun "$cli" "$@"
fi
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  case $major in
    '' | *[!0-9]*) major=0 ;;
  esac
  if [ "$major" -ge 22 ]; then
    exec node "$cli" "$@"
  fi
  echo "acde: needs Node.js 22 or newer, and the node on PATH is $(node --version 2>/dev/null || echo unknown): install a newer Node.js (https://nodejs.org) or Bun (https://bun.sh)" >&2
  exit 1
fi
echo "acde: needs Bun or Node.js 22+ and there is neither on PATH: install Bun (https://bun.sh) or Node.js (https://nodejs.org)" >&2
exit 1
