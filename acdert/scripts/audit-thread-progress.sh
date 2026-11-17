#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/.."
mkdir -p logs
run_dir=$(mktemp -d logs/thread-audit.XXXXXX)
printf 'Thread audit artifacts: %s\n' "$run_dir"
bun scripts/audit-thread-progress.ts "$run_dir" 2>&1 | tee "$run_dir/audit.log"
