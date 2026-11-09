#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
here="$repo/scripts/release"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sha=1111111111111111111111111111111111111111
other=2222222222222222222222222222222222222222

make_repo() {
  local dir=$1 cargo=$2 sdk=$3
  mkdir -p "$dir/web/packages/acde-api" "$dir/web/packages/acde-dom" "$dir/web/packages/acde-host"
  printf '[workspace.package]\nversion = "%s"\n' "$cargo" > "$dir/Cargo.toml"
  printf '{"name": "@dopame/acde-api", "version": "%s"}\n' "$sdk" > "$dir/web/packages/acde-api/package.json"
  printf '{"name": "@dopame/acde-dom", "version": "%s"}\n' "$cargo" > "$dir/web/packages/acde-dom/package.json"
  printf '{"name": "@dopame/acde-host", "version": "%s"}\n' "$cargo" > "$dir/web/packages/acde-host/package.json"
}

tags_file() {
  local file=$work/tags-$1
  shift
  : > "$file"
  for line in "$@"; do printf '%s\n' "$line" >> "$file"; done
  printf '%s' "$file"
}

run_plan() {
  local name=$1 repo_dir=$2 event=$3 ref_type=$4 ref_name=$5 tags=$6 publish=${7:-false}
  local output=$work/output-$name
  : > "$output"
  set +e
  REPO="$repo_dir" RELEASE_REMOTE_TAGS="$tags" GITHUB_OUTPUT="$output" \
    "$here/plan.sh" "$event" "$ref_type" "$ref_name" "$sha" "$publish" > "$work/log-$name" 2>&1
  status=$?
  set -e
  cat "$work/log-$name"
}

expect_output() {
  local name=$1 key=$2 want=$3
  local got
  got=$(sed -n "s/^$key=//p" "$work/output-$name")
  if [ "$got" != "$want" ]; then
    echo "FAIL $name: $key is '${got:-empty}', want '$want'" >&2
    exit 1
  fi
  echo "ok   $name: $key=$want"
}

expect_fail() {
  local name=$1 reason=$2
  if [ "$status" = 0 ]; then
    echo "FAIL $name: the plan succeeded, want a failure" >&2
    exit 1
  fi
  if ! grep -q "$reason" "$work/log-$name"; then
    echo "FAIL $name: the failure does not explain '$reason'" >&2
    cat "$work/log-$name" >&2
    exit 1
  fi
  echo "ok   $name: failed, $reason"
}

ok_repo=$work/ok
make_repo "$ok_repo" 0.0.5 0.0.5
bad_repo=$work/bad
make_repo "$bad_repo" 0.0.5 0.0.6

echo "== rehearsal (publish=false): builds and checks only, whatever the tags"
tags=$(tags_file rehearsal)
run_plan rehearsal "$ok_repo" workflow_dispatch branch main "$tags" false
expect_output rehearsal mode preview

echo "== rehearsal with the tag already on origin at another commit (still preview)"
tags=$(tags_file rehearsal-tag "$other	refs/tags/v0.0.5")
run_plan rehearsal-tag "$ok_repo" workflow_dispatch branch main "$tags" false
expect_output rehearsal-tag mode preview

echo "== rehearsal with a mismatched version (fail)"
tags=$(tags_file rehearsal-bad)
run_plan rehearsal-bad "$bad_repo" workflow_dispatch branch main "$tags" false
expect_fail rehearsal-bad "do not match Cargo.toml"

echo "== formal release, version is new: new (tag, release, upload)"
tags=$(tags_file publish-new)
run_plan publish-new "$ok_repo" workflow_dispatch branch main "$tags" true
expect_output publish-new mode new
expect_output publish-new tag v0.0.5
expect_output publish-new version 0.0.5

echo "== formal release retried after a failed upload, tag at this commit: resume"
tags=$(tags_file publish-resume "$sha	refs/tags/v0.0.5")
run_plan publish-resume "$ok_repo" workflow_dispatch branch main "$tags" true
expect_output publish-resume mode resume

echo "== formal release, annotated tag: the peeled commit decides"
tags=$(tags_file publish-peeled "$other	refs/tags/v0.0.5" "$sha	refs/tags/v0.0.5^{}")
run_plan publish-peeled "$ok_repo" workflow_dispatch branch main "$tags" true
expect_output publish-peeled mode resume

echo "== formal release, tag already exists at another commit (fail with the reason)"
tags=$(tags_file publish-exists "$other	refs/tags/v0.0.5")
run_plan publish-exists "$ok_repo" workflow_dispatch branch main "$tags" true
expect_fail publish-exists "already exists at $other"

echo "== formal release from a branch other than main (fail)"
tags=$(tags_file publish-branch)
run_plan publish-branch "$ok_repo" workflow_dispatch branch feature "$tags" true
expect_fail publish-branch "only on main"

echo "== formal release from a tag ref (fail)"
tags=$(tags_file publish-tagref "$sha	refs/tags/v0.0.5")
run_plan publish-tagref "$ok_repo" workflow_dispatch tag v0.0.5 "$tags" true
expect_fail publish-tagref "only on main"

echo "== formal release with a mismatched version (fail)"
tags=$(tags_file publish-bad)
run_plan publish-bad "$bad_repo" workflow_dispatch branch main "$tags" true
expect_fail publish-bad "do not match Cargo.toml"

echo "== release triggered by a push (fail: only workflow_dispatch starts a release)"
tags=$(tags_file push)
run_plan push "$ok_repo" push branch main "$tags" false
expect_fail push "only from workflow_dispatch"

echo "== publish input that is neither true nor false (fail)"
tags=$(tags_file publish-junk)
run_plan publish-junk "$ok_repo" workflow_dispatch branch main "$tags" yes
expect_fail publish-junk "true or false"

echo "== version that is not 0.0.N (fail)"
odd_repo=$work/odd
make_repo "$odd_repo" 1.2.3 1.2.3
tags=$(tags_file odd)
run_plan odd "$odd_repo" workflow_dispatch branch main "$tags" false
expect_fail odd "not 0.0.N"

echo "plan dry run passed: rehearsal stays preview, a formal release is new or resumed on main,"
echo "  an existing tag at another commit fails, and a mismatch or a non-main branch is refused"
