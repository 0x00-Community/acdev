#!/usr/bin/env bash
# scripts/release/cos.sh <put|verify|latest|selftest> ...: runs cos.py with cos-python-sdk-v5, through uv when the runner
# has it, else in a python3 venv kept under RUNNER_TEMP (or TMPDIR) for the rest of the job.
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = selftest ]; then
  if command -v uv > /dev/null; then exec uv run --no-project python "$here/cos.py" selftest; fi
  exec python3 "$here/cos.py" selftest
fi
if command -v uv > /dev/null; then
  exec uv run --no-project --with cos-python-sdk-v5 python "$here/cos.py" "$@"
fi
venv="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/acdert-cos-venv"
if [ ! -x "$venv/bin/python" ]; then
  if ! python3 -m venv "$venv" 2> /dev/null; then
    sudo apt-get update > /dev/null && sudo apt-get install -y --no-install-recommends python3-venv > /dev/null
    python3 -m venv "$venv"
  fi
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check cos-python-sdk-v5
fi
exec "$venv/bin/python" "$here/cos.py" "$@"
