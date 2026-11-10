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
# op|path in package/|body|error the check must report
for variant in \
  "add|src/validate.ts|export {}|TypeScript source" \
  "add|src/runtime/load.ts|export {}|TypeScript source" \
  "add|src/index.js.map|{}|source map: " \
  "add|src/types/page.d.ts.map|{}|source map: " \
  "add|scripts/build.mjs|// build|build scripts" \
  "add|src/runtime/scripts/gen.js|// gen|build scripts" \
  "add|test/validate.test.ts|test|has tests" \
  "add|src/runtime/test/load.test.js|test|has tests" \
  "add|src/index.js|//# sourceMappingURL=index.js.map|source map reference" \
  "add|src/runtime/load.js|//# sourceMappingURL=load.js.map|source map reference" \
  "add|src/types/page.d.ts|// sourcesContent|source map reference" \
  "add|src/Extra/load.js|export {}|outside the published layout" \
  "add|src/runtime/notes.md|notes|outside the published layout" \
  "add|extra.js|export {}|outside the published layout" \
  "rm|src/runtime/level.js||which the archive does not have" \
  "rm|src/types/page.d.ts||which the archive does not have" \
  "rm|src/app.d.ts||points to a file the archive does not have" \
  "unexport|./app||exports has no \"./app\"" \
  "unexport|./shell||exports has no \"./shell\""; do
  IFS='|' read -r op name body expect <<< "$variant"
  rm -rf "$sdk_work"
  mkdir -p "$sdk_work"
  tar -C "$sdk_work" -xzf "$good"
  case "$op" in
    add)
      mkdir -p "$(dirname -- "$sdk_work/package/$name")"
      printf '%s\n' "$body" >> "$sdk_work/package/$name" ;;
    rm) rm "$sdk_work/package/$name" ;;
    unexport)
      (cd "$sdk_work/package" && node -e '
        const fs = require("fs");
        const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
        delete pkg.exports[process.argv[1]];
        fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
      ' "$name") ;;
  esac
  tar -C "$sdk_work" -czf "$sdk" package
  if out=$("$here/check-stage.sh" "$work/stage" "$version" 2>&1); then
    echo "FAIL: the check accepted $op $name in the sdk archive" >&2
    exit 1
  fi
  if ! grep -qF -- "$expect" <<< "$out"; then
    echo "FAIL: the check rejected $op $name, but not with \"$expect\":" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  echo "rejected $op $name: $expect"
  cp "$good" "$sdk"
done

"$here/check-stage.sh" "$work/stage" "$version"
echo "dry run passed: symbols never reached the staging, the sdk archive holds only the published layout, and the check rejects leaks"
