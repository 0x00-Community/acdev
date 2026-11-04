#!/bin/sh
# The npm packages, as tarballs in npm/dist (publish them, or try them with CREATE_ACDE_LOCAL=npm/dist):
#   @dopame/acde-linux-x64  the runtime: bin/acde (the release build), bin/app (acde-host's bundles, brand, login page),
#                           bin/acde-app and bin/acde-api (what `acde app` runs under bun)
#   acde                    `acde` on PATH: runs the platform package's binary, hands it the bun it depends on
#   create-acde             `npm create acde`: a project from acde-app's templates
#   @dopame/acde-api        the SDK the projects depend on
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
here="$root/npm"
out="$here/dist"
version=$(node -p "require('$here/acde/package.json').version")

cd "$root"
cargo build --locked --release -p acde
(cd js && bun install --frozen-lockfile >/dev/null && bun run --filter @dopame/acde-host bundle >/dev/null)

platform="$here/acde-linux-x64/bin"
rm -rf "$platform" && mkdir -p "$platform/app/dist"
install -m755 target/release/acde "$platform/acde"
host=js/packages/acde-host
cp "$host/dist/broker.js" "$host/dist/isolate.js" "$platform/app/dist/"
cp "$host/package.json" "$host/LICENSE" "$platform/app/"
cp -r "$host/brand" "$host/greet" "$platform/app/"
for pkg in acde-app acde-api; do
  mkdir -p "$platform/$pkg"
  cp "js/packages/$pkg/package.json" "$platform/$pkg/"
  cp -r "js/packages/$pkg/src" "$platform/$pkg/src"
done
cp -r js/packages/acde-app/templates "$platform/acde-app/templates"
cp js/packages/acde-api/config.schema.json "$platform/acde-api/"

rm -rf "$here/create-acde/templates"
cp -r js/packages/acde-app/templates "$here/create-acde/templates"

for pkg in acde acde-linux-x64 create-acde; do
  node -e "const f='$here/$pkg/package.json',p=require(f);p.version='$version';if(p.optionalDependencies)for(const k in p.optionalDependencies)p.optionalDependencies[k]='$version';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
done

rm -rf "$out" && mkdir -p "$out"
for pkg in "$here/acde-linux-x64" "$here/acde" "$here/create-acde" "$root/js/packages/acde-api"; do
  (cd "$pkg" && npm pack --silent --pack-destination "$out" >/dev/null)
done
ls -l "$out"
