#!/usr/bin/env bash
set -euo pipefail

event=$1
ref_type=$2
ref_name=$3
run_sha=$4
publish=${5:-false}
requested=${6:-}
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
if [ "$publish" = true ] && [ -z "$requested" ]; then
  fail "a formal release needs the commit to publish (input commit)"
fi

git -C "$repo" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || fail "cannot fetch origin/main"

if [ -n "$requested" ]; then
  sha=$(git -C "$repo" rev-parse --verify --quiet "$requested^{commit}") || fail "commit $requested is not in this repository"
  main_head=$(git -C "$repo" rev-parse origin/main)
  if [ "$sha" != "$main_head" ] && ! git -C "$repo" merge-base --is-ancestor "$sha" "$main_head"; then
    fail "commit $sha is not origin/main or one of its ancestors"
  fi
else
  sha=$run_sha
fi

show() {
  git -C "$repo" show "$sha:$1"
}

cargo_text=$(show Cargo.toml) || fail "no Cargo.toml at $sha"
cargo_version=$(printf '%s\n' "$cargo_text" | awk '
  /^\[workspace\.package\]/ { in_section = 1; next }
  /^\[/ { in_section = 0 }
  in_section && /^version[[:space:]]*=/ {
    if (match($0, /"[^"]+"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  }
')
[ -n "$cargo_version" ] || fail "no workspace.package.version in Cargo.toml at $sha"

mismatch=0
for dir in $(git -C "$repo" ls-tree -d --name-only "$sha" web/packages/); do
  manifest_text=$(show "$dir/package.json") || fail "no package.json in $dir at $sha"
  name=$(printf '%s' "$manifest_text" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).name")
  pkg_version=$(printf '%s' "$manifest_text" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
  if [ "$pkg_version" != "$cargo_version" ]; then
    echo "::error::$name is $pkg_version but the workspace is $cargo_version" >&2
    mismatch=1
  fi
done
[ "$mismatch" = 0 ] || fail "package versions do not match Cargo.toml at $sha; bump them together (AGENTS.md 发版)"

version=$cargo_version
[[ "$version" =~ ^0\.0\.[0-9]+$ ]] || fail "version $version is not 0.0.N"
tag="v$version"

remote=$(git -C "$repo" ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
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
  fail "$tag already exists at $tag_sha, not at $sha; bump the version before a new release (AGENTS.md 发版)"
fi

echo "commit=$sha version=$version tag=$tag mode=$mode"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "sha=$sha"
    echo "version=$version"
    echo "tag=$tag"
    echo "mode=$mode"
  } >> "$GITHUB_OUTPUT"
fi
