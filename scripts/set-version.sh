#!/bin/sh
# Write one release version into what the build reads it from, without committing it: the [workspace.package] version of
# acdebin-dbg's and acdert's Cargo.toml, npm/package.json, and acdert's web/packages/*/package.json (after bun install:
# web/bun.lock records those versions).
# Usage: set-version.sh <x.y.z> <acdebin-dbg dir> <acdert dir>
set -eu
v=$1 dbg=$2 lib=$3
case $v in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "set-version.sh: $v is not x.y.z" >&2; exit 2 ;; esac
for toml in "$dbg/Cargo.toml" "$lib/Cargo.toml"; do
  [ -f "$toml" ] || continue
  sed -i "/^\[workspace.package\]/,/^\[/s/^version = \".*\"$/version = \"$v\"/" "$toml"
done
for json in "$dbg/npm/package.json" "$lib"/web/packages/*/package.json; do
  [ -f "$json" ] || continue
  node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$json" "$v"
done
echo "version $v"
