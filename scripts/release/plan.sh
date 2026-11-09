#!/usr/bin/env bash
set -euo pipefail

event=$1
ref_type=$2
ref_name=$3
sha=$4
publish=${5:-false}
here=$(dirname -- "$0")
repo=${REPO:-$(cd -- "$here/../.." && pwd)}

fail() {
  echo "::error::$*" >&2
  exit 1
}

[ "$event" = workflow_dispatch ] || fail "release runs only from workflow_dispatch, not from $event"
case "$publish" in
  true | false) ;;
  *) fail "publish must be true or false, not $publish" ;;
esac
if [ "$publish" = true ] && { [ "$ref_type" != branch ] || [ "$ref_name" != main ]; }; then
  fail "a formal release runs only on main"
fi

cargo_version=$(awk '
  /^\[workspace\.package\]/ { in_section = 1; next }
  /^\[/ { in_section = 0 }
  in_section && /^version[[:space:]]*=/ {
    if (match($0, /"[^"]+"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  }
' "$repo/Cargo.toml")
[ -n "$cargo_version" ] || fail "no workspace.package.version in Cargo.toml"

mismatch=0
for manifest in "$repo"/web/packages/*/package.json; do
  name=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).name" "$manifest")
  pkg_version=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$manifest")
  if [ "$pkg_version" != "$cargo_version" ]; then
    echo "::error::$name is $pkg_version but the workspace is $cargo_version" >&2
    mismatch=1
  fi
done
[ "$mismatch" = 0 ] || fail "package versions do not match Cargo.toml; bump them together (AGENTS.md 发版)"

version=$cargo_version
[[ "$version" =~ ^0\.0\.[0-9]+$ ]] || fail "version $version is not 0.0.N"
tag="v$version"

if [ -n "${RELEASE_REMOTE_TAGS:-}" ]; then
  remote=$(cat "$RELEASE_REMOTE_TAGS")
else
  remote=$(git -C "$repo" ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
fi
peeled=$(awk -v ref="refs/tags/$tag^{}" '$2 == ref { print $1 }' <<< "$remote")
direct=$(awk -v ref="refs/tags/$tag" '$2 == ref { print $1 }' <<< "$remote")
tag_sha=${peeled:-$direct}

if [ "$publish" = false ]; then
  mode=preview
elif [ -z "$tag_sha" ]; then
  mode=new
elif [ "$tag_sha" = "$sha" ]; then
  mode=resume
else
  fail "$tag already exists at $tag_sha, not at this commit $sha; bump the version before a new release (AGENTS.md 发版)"
fi

echo "version=$version tag=$tag mode=$mode"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$version"
    echo "tag=$tag"
    echo "mode=$mode"
  } >> "$GITHUB_OUTPUT"
fi
