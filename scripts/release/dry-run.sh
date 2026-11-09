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
echo "sdk archive entries:"
tar -tzf "$work/stage/acde-api-$version.tar.gz" | sed 's/^/  /'

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

sdk="$work/stage/acde-api-$version.tar.gz"
good="$work/good-sdk.tgz"
cp "$sdk" "$good"
sdk_work="$work/poison"
for variant in \
  "src/validate.ts|export {}" \
  "src/index.js.map|{}" \
  "scripts/build.mjs|// build" \
  "test/validate.test.ts|test" \
  "src/index.js|//# sourceMappingURL=index.js.map"; do
  name=${variant%%|*}
  body=${variant#*|}
  rm -rf "$sdk_work"
  mkdir -p "$sdk_work"
  tar -C "$sdk_work" -xzf "$good"
  mkdir -p "$(dirname -- "$sdk_work/package/$name")"
  printf '%s\n' "$body" >> "$sdk_work/package/$name"
  tar -C "$sdk_work" -czf "$sdk" package
  if "$here/check-stage.sh" "$work/stage" "$version" >/dev/null 2>&1; then
    echo "FAIL: the check accepted $name in the sdk archive" >&2
    exit 1
  fi
  cp "$good" "$sdk"
done

"$here/check-stage.sh" "$work/stage" "$version"
echo "dry run passed: symbols never reached the staging, the sdk archive holds only the published layout, and the check rejects leaks"
