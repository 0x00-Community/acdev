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

if [ "$problems" != 0 ]; then
  exit 1
fi
echo "release staging ok: $(ls -A "$dir" | tr '\n' ' ')"
