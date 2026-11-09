#!/usr/bin/env bash
set -euo pipefail

artifacts=$1
version=$2
out=$3
here=$(dirname -- "$0")
mkdir -p "$out"

for entry in "x86_64-unknown-linux-gnu:" "aarch64-apple-darwin:" "x86_64-pc-windows-msvc:.exe"; do
  triple=${entry%%:*}
  ext=${entry#*:}
  src="$artifacts/acdert-$triple/acdert-$triple$ext"
  if [ ! -f "$src" ]; then
    echo "::error::missing binary $src" >&2
    exit 1
  fi
  cp "$src" "$out/acdert-$triple$ext"
done

if [ ! -f "$artifacts/host/LICENSE" ] || [ ! -d "$artifacts/host/app" ]; then
  echo "::error::the host artifact has no app/ or LICENSE" >&2
  exit 1
fi
cp "$artifacts/host/LICENSE" "$out/LICENSE"
tar -C "$artifacts/host" -czf "$out/acdert-host-$version.tar.gz" app LICENSE

repo=$(cd -- "$here/../.." && pwd)
tar -C "$repo/web/packages" --exclude acde-api/test --exclude acde-api/node_modules \
  -czf "$out/acde-api-$version.tar.gz" acde-api

"$here/check-stage.sh" "$out" "$version"
