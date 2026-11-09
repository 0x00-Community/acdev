#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "$0")/../.."
run_dir=$(mktemp -d logs/manual-file-chooser.XXXXXX)
printf 'Manual file chooser artifacts: %s\n' "$run_dir"
bun scripts/file-chooser/manual-file-chooser.ts "$run_dir" "$@"
