#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=dry-run GIT_AUTHOR_EMAIL=dry-run@example.invalid
export GIT_COMMITTER_NAME=dry-run GIT_COMMITTER_EMAIL=dry-run@example.invalid

origin=$work/origin.git
seed=$work/seed
git init -q --bare "$origin"
git init -q -b main "$seed"
git -C "$seed" config core.autocrlf false
git -C "$seed" remote add origin "$origin"

snapshot() {
  local cargo=$1 sdk=$2 message=$3
  mkdir -p "$seed/web/packages/acde-api" "$seed/web/packages/acde-dom" "$seed/web/packages/acde-host"
  printf '[workspace.package]\nversion = "%s"\n' "$cargo" > "$seed/Cargo.toml"
  printf '{"name": "@dopame/acde-api", "version": "%s"}\n' "$sdk" > "$seed/web/packages/acde-api/package.json"
  printf '{"name": "@dopame/acde-dom", "version": "%s"}\n' "$cargo" > "$seed/web/packages/acde-dom/package.json"
  printf '{"name": "@dopame/acde-host", "version": "%s"}\n' "$cargo" > "$seed/web/packages/acde-host/package.json"
  git -C "$seed" add -A
  git -C "$seed" commit -q -m "$message"
  git -C "$seed" rev-parse HEAD
}

tag_at() {
  git -C "$seed" tag -a "$1" -m "$1" "$2"
  git -C "$seed" push -q origin "refs/tags/$1"
}

run_plan() {
  local name=$1 event=$2 ref_type=$3 ref_name=$4 run_sha=$5 publish=$6 commit=$7
  local output=$work/output-$name
  : > "$output"
  set +e
  REPO="$seed" GITHUB_OUTPUT="$output" \
    "$here/plan.sh" "$event" "$ref_type" "$ref_name" "$run_sha" "$publish" "$commit" > "$work/log-$name" 2>&1
  status=$?
  set -e
  cat "$work/log-$name"
}

expect_output() {
  local name=$1 key=$2 want=$3 got
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
  if ! grep -q -- "$reason" "$work/log-$name"; then
    echo "FAIL $name: the failure does not explain '$reason'" >&2
    cat "$work/log-$name" >&2
    exit 1
  fi
  echo "ok   $name: failed, $reason"
}

A=$(snapshot 0.0.4 0.0.4 "A: 0.0.4 on main")
B=$(snapshot 0.0.5 0.0.5 "B: 0.0.5 on main")
git -C "$seed" checkout -q -b feature "$B"
C=$(snapshot 0.0.6 0.0.6 "C: 0.0.6 on a feature branch")
git -C "$seed" checkout -q main
M2=$(snapshot 0.0.5 0.0.6 "M2: sdk version does not match the workspace")
M3=$(snapshot 1.2.3 1.2.3 "M3: version is not 0.0.N")
git -C "$seed" push -q origin main
RUN=$B

echo "== formal release without a commit (fail)"
run_plan no-commit workflow_dispatch branch main "$RUN" true ""
expect_fail no-commit "needs the commit to publish"

echo "== rehearsal without a commit: the run commit is used"
run_plan rehearsal workflow_dispatch branch main "$RUN" false ""
expect_output rehearsal mode preview
expect_output rehearsal sha "$RUN"

echo "== rehearsal with a short commit: resolved to the full sha"
run_plan rehearsal-short workflow_dispatch branch main "$RUN" false "${B:0:7}"
expect_output rehearsal-short sha "$B"
expect_output rehearsal-short mode preview

echo "== rehearsal of a commit not on main (fail)"
run_plan rehearsal-feature workflow_dispatch branch main "$RUN" false "$C"
expect_fail rehearsal-feature "is not origin/main or one of its ancestors"

echo "== formal release of main's commit B, no tag yet (new)"
run_plan publish-b workflow_dispatch branch main "$RUN" true "$B"
expect_output publish-b mode new
expect_output publish-b sha "$B"
expect_output publish-b version 0.0.5
expect_output publish-b tag v0.0.5

echo "== formal release of an old commit A: the version comes from A, not from main's head"
run_plan publish-a workflow_dispatch branch main "$RUN" true "$A"
expect_output publish-a mode new
expect_output publish-a sha "$A"
expect_output publish-a version 0.0.4
expect_output publish-a tag v0.0.4

echo "== tag v0.0.5 already on origin at this commit B: resume"
tag_at v0.0.5 "$B"
run_plan publish-b-resume workflow_dispatch branch main "$RUN" true "$B"
expect_output publish-b-resume mode resume
expect_output publish-b-resume sha "$B"

echo "== tag v0.0.4 already on origin at B, not at A: fail with the reason"
tag_at v0.0.4 "$B"
run_plan publish-a-moved workflow_dispatch branch main "$RUN" true "$A"
expect_fail publish-a-moved "already exists at $B"

echo "== formal release of a commit not on main (fail)"
run_plan publish-feature workflow_dispatch branch main "$RUN" true "$C"
expect_fail publish-feature "is not origin/main or one of its ancestors"

echo "== formal release of a commit with mismatched package versions (fail)"
run_plan publish-mismatch workflow_dispatch branch main "$RUN" true "$M2"
expect_fail publish-mismatch "do not match Cargo.toml"

echo "== formal release of a commit whose version is not 0.0.N (fail)"
run_plan publish-odd workflow_dispatch branch main "$RUN" true "$M3"
expect_fail publish-odd "not 0.0.N"

echo "== formal release from a branch other than main (fail)"
run_plan publish-branch workflow_dispatch branch feature "$RUN" true "$B"
expect_fail publish-branch "only on main"

echo "== formal release of a commit that is not in this repository (fail)"
run_plan publish-missing workflow_dispatch branch main "$RUN" true "0123456789abcdef0123456789abcdef01234567"
expect_fail publish-missing "is not in this repository"

echo "== release triggered by a push (fail)"
run_plan push push branch main "$RUN" false ""
expect_fail push "only from workflow_dispatch"

echo "== publish input that is neither true nor false (fail)"
run_plan publish-junk workflow_dispatch branch main "$RUN" yes "$B"
expect_fail publish-junk "true or false"

echo "plan dry run passed: the commit is resolved to a full sha on main, the version and tag come from that commit,"
echo "  a formal release needs a commit, refuses other commits, existing tags elsewhere, mismatches and non-main branches"
