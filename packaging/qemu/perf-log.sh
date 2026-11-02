#!/usr/bin/env dash
# Sums up acde's perf timing lines (RUST_LOG=perf=debug, see AGENTS.md "日志和计时") from a log file or stdin:
# one row per kind of measurement (target + the words before the first key=value), with count, p50 / p95 / max / mean of
# ms=, and the mean of every other numeric key=value on those lines.
# Usage: perf-log.sh [FILE...]    e.g. journalctl -b -t acde -o cat | packaging/qemu/perf-log.sh
set -eu
awk '
  match($0, / perf::[a-z_]+: /) {
    target = substr($0, RSTART + 7, RLENGTH - 9)
    n = split(substr($0, RSTART + RLENGTH), words, " ")
    key = target; ms = ""; fields = ""; keyed = 0
    for (i = 1; i <= n; i++) {
      eq = index(words[i], "=")
      if (eq == 0) { if (!keyed) key = key " " words[i]; continue }
      keyed = 1
      name = substr(words[i], 1, eq - 1); value = substr(words[i], eq + 1)
      if (name == "ms") ms = value
      else if (name != "commit" && name != "owner" && value ~ /^-?[0-9.]+$/) fields = fields " " name "=" value
    }
    if (ms != "") printf "%s\t%s\t%s\n", key, ms, fields
  }
' "$@" | sort -t "$(printf '\t')" -k1,1 -k2,2g | awk -F '\t' '
  function flush() {
    if (count == 0) return
    line = sprintf("%-40s %6d %9.2f %9.2f %9.2f %9.2f", group, count, values[int((count - 1) * 0.5) + 1], values[int((count - 1) * 0.95) + 1], values[count], total / count)
    for (f in sums) line = line sprintf("  %s=%.2f", f, sums[f] / seen[f])
    print line
    count = 0; total = 0; split("", values); split("", sums); split("", seen)
  }
  BEGIN { printf "%-40s %6s %9s %9s %9s %9s\n", "kind", "count", "p50", "p95", "max", "mean" }
  $1 != group { flush(); group = $1 }
  {
    values[++count] = $2; total += $2
    n = split($3, pairs, " ")
    for (i = 1; i <= n; i++) { eq = index(pairs[i], "="); f = substr(pairs[i], 1, eq - 1); sums[f] += substr(pairs[i], eq + 1); seen[f]++ }
  }
  END { flush() }
'
