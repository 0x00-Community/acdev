#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/../.."
mkdir -p logs
run_dir=$(mktemp -d logs/dom-perf.XXXXXX)
printf 'DOM perf artifacts: %s\n' "$run_dir"
bun scripts/dom-perf/bench.ts "$run_dir" 2>&1 | tee "$run_dir/bench.log"
