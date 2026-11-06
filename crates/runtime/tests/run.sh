#!/usr/bin/env dash
# Run one of the checks here under acde (no Node): HOME and TMPDIR in a fresh directory under $ACDE_CHECK_TMP
# (default: $TMPDIR, else /tmp), removed after.
# Usage: crates/runtime/tests/run.sh <acde binary> <check.mjs>
set -eu
acde=$(realpath "$1")
script=$(realpath "$2")
scratch=$(mktemp -d "${ACDE_CHECK_TMP:-${TMPDIR:-/tmp}}/acde-check.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/home" "$scratch/tmp"
env -u XDG_DESKTOP_DIR -u XDG_CONFIG_HOME -u XDG_STATE_HOME HOME="$scratch/home" TMPDIR="$scratch/tmp" SHELL=/bin/bash "$acde" run "$script"
