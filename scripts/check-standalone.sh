#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/.."
mkdir -p logs
run_dir=$(mktemp -d logs/standalone.XXXXXX)
printf 'Standalone app artifacts: %s\n' "$run_dir"
bun scripts/check-standalone.ts "$run_dir" 2>&1 | tee "$run_dir/smoke.log"
