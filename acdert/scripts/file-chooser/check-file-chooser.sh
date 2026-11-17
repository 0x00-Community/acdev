#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/../.."
run_dir=$(mktemp -d logs/file-chooser.XXXXXX)
printf 'File chooser artifacts: %s\n' "$run_dir"
bun scripts/file-chooser/check-file-chooser.ts "$run_dir" 2>&1 | tee "$run_dir/smoke.log"
