#!/usr/bin/env bash
set -euo pipefail

dir=$1
version=$2
. "$(dirname -- "$0")/targets.sh"
targets=$(release_targets)
required=()
for triple in $targets; do required+=("$(target_archive "$triple")"); done
required+=(
  "acdert-host-$version.tar.gz"
  "acde-api-$version.tar.gz"
  "LICENSE"
)
optional=("SHA256SUMS")
problems=0

# A binary archive holds one executable plain file and nothing else:
# acdert in the .tar.xz of macOS and Linux, acdert.exe in the Windows
# .tar.gz. The installers place exactly that member.
check_runtime() {
  local archive=$1 member=$2 names verbose
  if ! names=$(tar -tf "$archive") || ! verbose=$(tar -tvf "$archive"); then
    echo "::error::cannot list the binary archive: $(basename "$archive")"
    return 1
  fi
  if [ "$names" != "$member" ]; then
    echo "::error::$(basename "$archive") must hold only $member, it holds:"
    sed 's/^/  /' <<< "$names"
    return 1
  fi
  case "$verbose" in
    -rwxr-xr-x*) ;;
    *)
      echo "::error::$member in $(basename "$archive") is not an executable plain file: $verbose"
      return 1 ;;
  esac
}

# The SDK archive must hold exactly the package layout: package.json, LICENSE,
# config.schema.json and the built src/ tree (.js and .d.ts, in plain
# lowercase subdirectories). Exports and relative imports must resolve.
check_sdk() {
  local archive=$1 list verbose entry bad=0 work
  if ! list=$(tar -tzf "$archive") || ! verbose=$(tar -tvzf "$archive"); then
    echo "::error::cannot list the sdk archive: $(basename "$archive")"
    return 1
  fi
  if grep -v '^[-d]' <<< "$verbose" | grep -q .; then
    echo "::error::sdk archive has entries that are not plain files or directories:"
    grep -v '^[-d]' <<< "$verbose" | sed 's/^/  /'
    bad=1
  fi
  while IFS= read -r entry; do
    case "$entry" in
      /* | .. | ../* | */../* | */.. | ./* | */./* | *//*)
        echo "::error::sdk archive has an unsafe path: $entry"; bad=1; continue ;;
      *.map)
        echo "::error::sdk archive has a source map: $entry"; bad=1; continue ;;
      scripts | scripts/* | */scripts | */scripts/ | */scripts/*)
        echo "::error::sdk archive has build scripts: $entry"; bad=1; continue ;;
      test | test/* | */test | */test/ | */test/*)
        echo "::error::sdk archive has tests: $entry"; bad=1; continue ;;
      *.ts)
        case "$entry" in
          *.d.ts) ;;
          *) echo "::error::sdk archive has TypeScript source: $entry"; bad=1; continue ;;
        esac ;;
    esac
    case "$entry" in
      package | package/ | package/package.json | package/LICENSE | package/config.schema.json | package/src/) continue ;;
    esac
    if [[ "$entry" =~ ^package/src/([a-z0-9][a-z0-9_-]*/)*$ ]] ||
      [[ "$entry" =~ ^package/src/([a-z0-9][a-z0-9_-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(js|d\.ts)$ ]]; then
      continue
    fi
    echo "::error::sdk archive entry outside the published layout: $entry"; bad=1
  done <<< "$list"
  [ "$bad" = 0 ] || return 1

  work=$(mktemp -d)
  if ! tar -C "$work" -xzf "$archive"; then
    echo "::error::cannot read the sdk archive: $(basename "$archive")"
    rm -rf "$work"
    return 1
  fi
  if grep -raq -e sourceMappingURL -e sourcesContent -e 'sourceURL=' "$work"; then
    echo "::error::sdk archive has a source map reference"; bad=1
  fi
  if [ ! -f "$work/package/package.json" ]; then
    echo "::error::sdk archive has no package/package.json"; bad=1
  elif ! node -e '
    const fs = require("fs");
    const path = require("path");
    const root = path.join(process.argv[1], "package");
    const problems = [];
    const isFile = (rel) => {
      try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
    };
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const exportsMap = pkg.exports ?? {};
    const required = [".", "./app", "./shell", "./vite", "./manifest", "./config.schema.json"];
    for (const key of required) if (!(key in exportsMap)) problems.push("exports has no " + JSON.stringify(key));
    for (const [key, target] of Object.entries(exportsMap)) {
      const files = typeof target === "string" ? [target] : [target.types, target.default];
      if (typeof target !== "string") {
        if (!(target.types && target.default)) problems.push("export " + key + " needs both types and default");
        if (target.types && !target.types.endsWith(".d.ts")) problems.push("export " + key + " types is not a .d.ts: " + target.types);
        if (target.default && !target.default.endsWith(".js")) problems.push("export " + key + " default is not a .js: " + target.default);
      }
      for (const file of files.filter(Boolean)) {
        if (!isFile(file.replace(/^\.\//, ""))) problems.push("export " + key + " points to a file the archive does not have: " + file);
      }
    }
    const manifest = exportsMap["./manifest"];
    if (!manifest || manifest.default !== "./src/validate.js" || manifest.types !== "./src/validate.d.ts") {
      problems.push("./manifest must point to ./src/validate.js and ./src/validate.d.ts");
    }
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const specifier = /(?:\bfrom|\bimport)\s*\(?\s*["\x27](\.{1,2}\/[^"\x27]*)["\x27]/g;
    for (const file of walk(path.join(root, "src"))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const declaration = rel.endsWith(".d.ts");
      for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(specifier)) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        const candidates = declaration
          ? [base, base + ".d.ts", base.replace(/\.js$/, ".d.ts"), base + "/index.d.ts"]
          : [base];
        if (base.startsWith("..") || !candidates.some(isFile)) problems.push(rel + " imports " + spec + ", which the archive does not have");
      }
    }
    for (const problem of problems) console.log("::error::sdk " + problem);
    process.exit(problems.length ? 1 : 0);
  ' "$work"; then
    bad=1
  fi
  rm -rf "$work"
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

for name_req in "${required[@]}"; do
  case "$name_req" in
    acdert-host-*) member="" ;;
    acdert-*.tar.xz) member=acdert ;;
    acdert-*.tar.gz) member=acdert.exe ;;
    *) member="" ;;
  esac
  if [ -n "$member" ] && [ -f "$dir/$name_req" ]; then
    check_runtime "$dir/$name_req" "$member" || problems=1
  fi
done

if [ -f "$dir/acde-api-$version.tar.gz" ]; then
  check_sdk "$dir/acde-api-$version.tar.gz" || problems=1
fi

if [ "$problems" != 0 ]; then
  exit 1
fi
echo "release staging ok: $(ls -A "$dir" | tr '\n' ' ')"
