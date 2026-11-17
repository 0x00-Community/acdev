#!/usr/bin/env bash
# The Dopame OS guest under QEMU: acdev vm from this checkout (docs/vm.md). ACDEV_VM_DIR is the older name of ACDE_VM_DIR.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
export ACDE_VM_DIR=${ACDE_VM_DIR:-${ACDEV_VM_DIR:-$root/.vm}}

if [[ ${1:-} == logs ]]; then
  exec tail -F "$ACDE_VM_DIR/logs/serial.log"
fi
command -v bun >/dev/null || { echo 'vm: bun not found' >&2; exit 1; }
exec bun "$root/npm/bin/acdev.mjs" vm "$@"
