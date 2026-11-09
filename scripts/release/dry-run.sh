#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
artifacts="$work/artifacts"
version=0.0.0-dry
here="$repo/scripts/release"

for triple in x86_64-unknown-linux-gnu aarch64-apple-darwin x86_64-pc-windows-msvc; do
  ext=""
  [ "$triple" = x86_64-pc-windows-msvc ] && ext=.exe
  mkdir -p "$artifacts/acdert-$triple" "$artifacts/symbols-$triple"
  printf 'binary %s\n' "$triple" > "$artifacts/acdert-$triple/acdert-$triple$ext"
  printf 'fake symbols %s\n' "$triple" > "$artifacts/symbols-$triple/acdert.dwp"
done
printf 'fake pdb\n' > "$artifacts/symbols-x86_64-pc-windows-msvc/acdert.pdb"
mkdir -p "$artifacts/symbols-aarch64-apple-darwin/acdert.dSYM"
printf 'fake dsym\n' > "$artifacts/symbols-aarch64-apple-darwin/acdert.dSYM/Info.plist"
mkdir -p "$artifacts/host/app/dist"
printf 'export {}\n' > "$artifacts/host/app/dist/web.js"
cp "$repo/LICENSE" "$artifacts/host/LICENSE"

"$here/stage.sh" "$artifacts" "$version" "$work/stage"
echo "staged: $(ls -A "$work/stage" | tr '\n' ' ')"

for leak in acdert.pdb acdert.dwp x.dSYM; do
  cp "$artifacts/symbols-x86_64-pc-windows-msvc/acdert.pdb" "$work/stage/$leak"
  if "$here/check-stage.sh" "$work/stage" "$version" >/dev/null 2>&1; then
    echo "FAIL: the check accepted $leak in the staging" >&2
    exit 1
  fi
  rm -f "$work/stage/$leak"
done
mkdir -p "$work/stage/extra-dir"
if "$here/check-stage.sh" "$work/stage" "$version" >/dev/null 2>&1; then
  echo "FAIL: the check accepted a directory in the staging" >&2
  exit 1
fi
rm -rf "$work/stage/extra-dir"
"$here/check-stage.sh" "$work/stage" "$version"
echo "dry run passed: symbols never reached the staging, and the check rejects them"
