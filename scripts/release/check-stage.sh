#!/usr/bin/env bash
set -euo pipefail

dir=$1
version=$2
required=(
  "acdert-x86_64-unknown-linux-gnu"
  "acdert-aarch64-apple-darwin"
  "acdert-x86_64-pc-windows-msvc.exe"
  "acdert-host-$version.tar.gz"
  "acde-api-$version.tar.gz"
  "LICENSE"
)
optional=("SHA256SUMS")
problems=0

check_sdk() {
  local archive=$1 list entry entries bad=0
  if ! list=$(tar -tzf "$archive"); then
    echo "::error::cannot list the sdk archive: $(basename "$archive")"
    return 1
  fi
  entries=$(mktemp)
  printf '%s\n' "$list" > "$entries"
  while IFS= read -r entry; do
    case "$entry" in
      *.map)
        echo "::error::sdk archive has a source map: $entry"; bad=1; continue ;;
      scripts | scripts/* | */scripts | */scripts/*)
        echo "::error::sdk archive has build scripts: $entry"; bad=1; continue ;;
      test | test/* | */test | */test/*)
        echo "::error::sdk archive has tests: $entry"; bad=1; continue ;;
      *.ts)
        case "$entry" in
          *.d.ts) ;;
          *) echo "::error::sdk archive has TypeScript source: $entry"; bad=1; continue ;;
        esac ;;
    esac
    case "$entry" in
      package | package/ | package/package.json | package/LICENSE | package/config.schema.json | package/src/) ;;
      package/src/*/*) echo "::error::sdk archive has a nested directory: $entry"; bad=1 ;;
      package/src/*.js | package/src/*.d.ts) ;;
      *) echo "::error::sdk archive entry outside the published layout: $entry"; bad=1 ;;
    esac
  done <<< "$list"
  local content
  content=$(tar -xzOf "$archive") || { echo "::error::cannot read the sdk archive: $(basename "$archive")"; bad=1; }
  if grep -aq -e sourceMappingURL -e sourcesContent -e 'sourceURL=' <<< "${content:-}"; then
    echo "::error::sdk archive has a source map reference"; bad=1
  fi
  local pkg
  if ! pkg=$(tar -xzOf "$archive" package/package.json); then
    echo "::error::sdk archive has no package/package.json"; bad=1
  elif ! printf '%s' "$pkg" | node -e '
    const fs = require("fs");
    const entries = new Set(fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((e) => e.replace(/\/$/, "")));
    const pkg = JSON.parse(fs.readFileSync(0, "utf8"));
    const problems = [];
    const need = (file) => {
      const path = "package/" + file.replace(/^\.\//, "");
      if (!entries.has(path)) problems.push("sdk archive is missing " + path);
    };
    for (const target of Object.values(pkg.exports ?? {})) {
      for (const file of typeof target === "string" ? [target] : [target.types, target.default].filter(Boolean)) need(file);
    }
    const manifest = pkg.exports?.["./manifest"];
    if (!manifest || manifest.default !== "./src/validate.js" || manifest.types !== "./src/validate.d.ts") {
      problems.push("./manifest must point to ./src/validate.js and ./src/validate.d.ts");
    }
    for (const problem of problems) console.log("::error::" + problem);
    process.exit(problems.length ? 1 : 0);
  ' "$entries"; then
    bad=1
  fi
  rm -f "$entries"
  return "$bad"
}

for entry in "$dir"/* "$dir"/.[!.]*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=$(basename "$entry")
  case "$name" in
    *.pdb | *.dSYM | *.dwp | *.debug)
      echo "::error::debug symbol file in release staging: $name"
      problems=1
      continue
      ;;
  esac
  if [ -L "$entry" ] || [ ! -f "$entry" ]; then
    echo "::error::not a plain file in release staging: $name"
    problems=1
    continue
  fi
  allowed=0
  for name_ok in "${required[@]}" "${optional[@]}"; do
    [ "$name" = "$name_ok" ] && allowed=1
  done
  if [ "$allowed" = 0 ]; then
    echo "::error::not on the release allow-list: $name"
    problems=1
  fi
done

for name_req in "${required[@]}"; do
  if [ ! -f "$dir/$name_req" ]; then
    echo "::error::missing from release staging: $name_req"
    problems=1
  fi
done

if [ -f "$dir/acde-api-$version.tar.gz" ]; then
  check_sdk "$dir/acde-api-$version.tar.gz" || problems=1
fi

if [ "$problems" != 0 ]; then
  exit 1
fi
echo "release staging ok: $(ls -A "$dir" | tr '\n' ' ')"
