#!/bin/sh
# Write one release version into what the build reads it from, without committing it: the [workspace.package] version of
# acdev's Cargo.toml (acdert/ and crates/hostwin take it from there), npm/package.json and the SDK's npm/acde-api/package.json.
# Usage: set-version.sh <x.y.z> <acdev checkout>
set -eu
v=$1 dir=$2
case $v in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "set-version.sh: $v is not x.y.z" >&2; exit 2 ;; esac
sed -i "/^\[workspace.package\]/,/^\[/s/^version = \".*\"$/version = \"$v\"/" "$dir/Cargo.toml"
for json in "$dir/npm/package.json" "$dir/npm/acde-api/package.json"; do
  node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$json" "$v"
done
echo "version $v"
