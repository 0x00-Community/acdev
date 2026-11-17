#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/../.."
run_dir=$(mktemp -d logs/release-perf.XXXXXX)
printf 'Release perf artifacts: %s\n' "$run_dir"
bun scripts/release-perf/bench.ts "$run_dir" 2>&1 | tee "$run_dir/bench.log"
