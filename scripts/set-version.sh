#!/bin/sh
# Write one release version into what the build reads it from, without committing it: the [workspace.package] version of
# acdev's Cargo.toml (crates/hostwin takes it from there) and of libacde's beside it (the runtime library acdert), npm/package.json
# and the SDK's libacde/acde-api/package.json.
# Usage: set-version.sh <x.y.z> <acdev checkout>   (libacde is the checkout beside it, <acdev checkout>/../libacde)
set -eu
v=$1 dir=$2
lib=$dir/../libacde
case $v in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "set-version.sh: $v is not x.y.z" >&2; exit 2 ;; esac
for toml in "$dir/Cargo.toml" "$lib/Cargo.toml"; do
  sed -i "/^\[workspace.package\]/,/^\[/s/^version = \".*\"$/version = \"$v\"/" "$toml"
done
for json in "$dir/npm/package.json" "$lib/acde-api/package.json"; do
  node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$json" "$v"
done
for lock in "$dir/Cargo.lock" "$lib/Cargo.lock"; do
  [ -f "$lock" ] || continue
  sed -i "/^name = \"\(acdev\|acde-hostwin\|libacde\)\"$/{n;s/^version = \".*\"$/version = \"$v\"/}" "$lock"
done
echo "version $v"
