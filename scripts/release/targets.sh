#!/usr/bin/env bash

ALL_TARGETS=(x86_64-unknown-linux-gnu aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc)

target_os() {
  case "$1" in
    x86_64-unknown-linux-gnu) echo ubuntu-24.04 ;;
    aarch64-apple-darwin) echo macos-15 ;;
    x86_64-apple-darwin) echo macos-15-intel ;;
    x86_64-pc-windows-msvc) echo windows-2025 ;;
    *) return 1 ;;
  esac
}

target_exe() {
  [ "$1" = x86_64-pc-windows-msvc ] && echo .exe || true
}

target_archive() {
  if [ "$1" = x86_64-pc-windows-msvc ]; then echo "acdert-$1.tar.gz"; else echo "acdert-$1.tar.xz"; fi
}

release_targets() {
  local list=${RELEASE_TARGETS:-${ALL_TARGETS[*]}} t
  for t in ${list//,/ }; do
    if ! target_os "$t" > /dev/null; then
      echo "::error::unknown release target $t (one of ${ALL_TARGETS[*]})" >&2
      return 1
    fi
    echo "$t"
  done
}

targets_without() {
  local skip=" ${1//,/ } " t left=()
  for t in ${skip}; do
    if ! target_os "$t" > /dev/null; then
      echo "::error::unknown target to skip: $t (one of ${ALL_TARGETS[*]})" >&2
      return 1
    fi
  done
  for t in "${ALL_TARGETS[@]}"; do
    case "$skip" in *" $t "*) ;; *) left+=("$t") ;; esac
  done
  if [ "${#left[@]}" = 0 ]; then
    echo "::error::skip_targets leaves no target to build" >&2
    return 1
  fi
  echo "${left[*]}"
}
