#!/bin/sh
# Write one release version into what the build reads it from, without committing it: the [workspace.package] version of
# acdev's Cargo.toml (crates/hostwin takes it from there) and of libacde's beside it (the runtime library acdert), npm/package.json
# and the SDK's libacde/acde-api/package.json; in both Cargo.lock files, every package that takes the workspace version; and the
# version requirement of a [workspace.dependencies] entry naming such a package (libacde pins acde-scene = "=<version>").
# Usage: set-version.sh <x.y.z> <acdev checkout>   (libacde is the checkout beside it, <acdev checkout>/../libacde)
set -eu
v=$1 dir=$2
lib=$dir/../libacde
case $v in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "set-version.sh: $v is not x.y.z" >&2; exit 2 ;; esac
for json in "$dir/npm/package.json" "$lib/acde-api/package.json"; do
  node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$json" "$v"
done
names=$(for toml in "$dir"/Cargo.toml "$dir"/crates/*/Cargo.toml "$lib"/Cargo.toml "$lib"/*/Cargo.toml; do
  [ -f "$toml" ] && grep -q '^version.workspace = true$' "$toml" && sed -n 's/^name = "\(.*\)"$/\1/p' "$toml" | head -n 1
done | paste -s -d '|' -)
for toml in "$dir/Cargo.toml" "$lib/Cargo.toml"; do
  sed -i "/^\[workspace.package\]/,/^\[/s/^version = \".*\"$/version = \"$v\"/" "$toml"
  awk -v names="|$names|" -v v="$v" '/^\[/ { deps = ($0 == "[workspace.dependencies]") }
    deps && /^[A-Za-z0-9_-]+ = \{/ && index(names, "|" $1 "|") > 0 { sub(/version = "=?[^"]*"/, "version = \"=" v "\"") }
    { print }' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
done
for lock in "$dir/Cargo.lock" "$lib/Cargo.lock"; do
  [ -f "$lock" ] || continue
  awk -v names="|$names|" -v v="$v" 'bump && /^version = "/ { $0 = "version = \"" v "\""; bump = 0 }
    /^name = "/ { n = $0; sub(/^name = "/, "", n); sub(/"$/, "", n); bump = index(names, "|" n "|") > 0 }
    { print }' "$lock" > "$lock.tmp" && mv "$lock.tmp" "$lock"
done
echo "version $v"
