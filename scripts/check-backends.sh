#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/.."
mkdir -p logs
run_dir=$(mktemp -d logs/backends.XXXXXX)
printf 'Backend check artifacts: %s\n' "$run_dir"
bun scripts/backends/check-backends.ts "$run_dir" 2>&1 | tee "$run_dir/check.log"
