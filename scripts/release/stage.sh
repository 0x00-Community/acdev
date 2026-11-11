#!/usr/bin/env bash
set -euo pipefail

artifacts=$1
version=$2
out=$3
here=$(dirname -- "$0")
. "$here/targets.sh"
targets=$(release_targets)
repo=$(cd -- "$here/../.." && pwd)
sdk="$repo/web/packages/acde-api"
mkdir -p "$out"
command -v xz >/dev/null || { echo "::error::xz is needed to compress the binaries" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pack() {
  local dir=$1 member=$2
  TZ=UTC touch -t 200001010000.00 "$dir/$member"
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then
    tar -C "$dir" --format=ustar --owner=0 --group=0 --numeric-owner -cf - "$member"
  else
    tar -C "$dir" --format=ustar --uid 0 --gid 0 --numeric-owner -cf - "$member"
  fi
}

for triple in $targets; do
  ext=$(target_exe "$triple")
  src="$artifacts/acdert-$triple/acdert-$triple$ext"
  if [ ! -f "$src" ]; then
    echo "::error::missing binary $src" >&2
    exit 1
  fi
  mkdir "$work/$triple"
  cp "$src" "$work/$triple/acdert$ext"
  chmod 755 "$work/$triple/acdert$ext"
  if [ -n "$ext" ]; then
    pack "$work/$triple" "acdert$ext" | gzip -9 -n > "$out/acdert-$triple.tar.gz"
  else
    pack "$work/$triple" acdert | xz -9 -T1 -c > "$out/acdert-$triple.tar.xz"
  fi
done

if [ ! -f "$artifacts/host/LICENSE" ] || [ ! -d "$artifacts/host/app" ]; then
  echo "::error::the host artifact has no app/ or LICENSE" >&2
  exit 1
fi
cp "$artifacts/host/LICENSE" "$out/LICENSE"
tar -C "$artifacts/host" -czf "$out/acdert-host-$version.tar.gz" app LICENSE

command -v bun >/dev/null || { echo "::error::bun is needed to build the acde-api SDK" >&2; exit 1; }
bun run --cwd "$sdk" build
sdk_work="$work/sdk"
mkdir "$sdk_work"
cp -R "$sdk/dist" "$sdk_work/package"
tar -C "$sdk_work" -czf "$out/acde-api-$version.tar.gz" package

"$here/check-stage.sh" "$out" "$version"
