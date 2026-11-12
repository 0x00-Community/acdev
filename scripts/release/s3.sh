#!/usr/bin/env bash
# scripts/release/s3.sh put <version-dir> <dest>        version directory, e.g. pkgs/0.0.9 -> acdert/0.0.9
# scripts/release/s3.sh verify <version-dir> <dest>     every object is there with the local sha256
# scripts/release/s3.sh latest <file> <dest> [<dir>]    latest.json, replaced; then invalidates it (and <dir>/*) on CloudFront
#
# Bucket and distribution come from S3_BUCKET and CF_DISTRIBUTION, credentials from the environment (the workflow's
# configure-aws-credentials step). Each object carries its SHA-256 as x-amz-meta-sha256. In a version directory an
# object that is already there with the same digest is skipped; one with a different or missing digest is an error and
# is not overwritten. Installs the AWS CLI v2 when the runner has none.
set -euo pipefail

: "${S3_BUCKET:?}"
immutable='public, max-age=31536000, immutable'
fresh='public, max-age=0, must-revalidate'

if ! command -v aws > /dev/null; then
  tmp=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscli.zip"
  command -v unzip > /dev/null || { sudo apt-get update > /dev/null && sudo apt-get install -y --no-install-recommends unzip > /dev/null; }
  unzip -q "$tmp/awscli.zip" -d "$tmp"
  if [ "$(id -u)" = 0 ]; then "$tmp/aws/install"; else sudo "$tmp/aws/install"; fi
fi

content_type() {
  case $1 in
    *.json) echo application/json ;;
    *.tar.xz) echo application/x-xz ;;
    *.tar.gz | *.tgz) echo application/gzip ;;
    LICENSE | SHA256SUMS) echo 'text/plain; charset=utf-8' ;;
    *) echo application/octet-stream ;;
  esac
}

checked_key() {
  local k=$1
  case "/$k/" in
    *//* | */./* | */../*) echo "refusing the key $k: no empty, . or .. segments" >&2; exit 1 ;;
  esac
  printf '%s' "$k"
}

remote_sha() {
  local err
  err=$(mktemp)
  if aws s3api head-object --bucket "$S3_BUCKET" --key "$1" --query 'Metadata.sha256' --output text 2> "$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -q '(404)' "$err"; then rm -f "$err"; echo missing; return 0; fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

op=${1:-}
case $op in
  put | verify)
    dir=$2 dest=$3
    for path in "$dir"/*; do
      [ -f "$path" ] || { echo "$path: the version directory holds only regular files" >&2; exit 1; }
      f=$(basename "$path")
      key=$(checked_key "$dest/$f")
      sum=$(sha256sum "$path" | cut -d' ' -f1)
      have=$(remote_sha "$key")
      if [ "$op" = verify ]; then
        [ "$have" = "$sum" ] || { echo "::error::$key does not match the local file ($have, not $sum)"; exit 1; }
        echo "ok $key"
        continue
      fi
      if [ "$have" = "$sum" ]; then echo "skip $f: the same content is already there"; continue; fi
      if [ "$have" != missing ]; then
        echo "::error::$key is there with sha256 $have, not $sum (missing or different metadata); refusing to overwrite"
        exit 1
      fi
      aws s3 cp "$path" "s3://$S3_BUCKET/$key" --only-show-errors \
        --content-type "$(content_type "$f")" --cache-control "$immutable" --metadata "sha256=$sum"
      [ "$(remote_sha "$key")" = "$sum" ] || { echo "::error::$key: uploaded, but the bucket reports another sha256"; exit 1; }
      echo "put $key"
    done
    ;;
  latest)
    file=$2 dest=$3 dir=${4:-}
    [ "$(basename "$dest")" = latest.json ] || { echo "latest writes only latest.json, not $dest" >&2; exit 1; }
    key=$(checked_key "$dest")
    aws s3 cp "$file" "s3://$S3_BUCKET/$key" --only-show-errors \
      --content-type application/json --cache-control "$fresh"
    echo "put $key"
    if [ -n "${CF_DISTRIBUTION:-}" ]; then
      paths=("/$key")
      [ -z "$dir" ] || paths+=("/$(checked_key "$dir")/*")
      aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION" --paths "${paths[@]}" \
        --query Invalidation.Id --output text
    fi
    ;;
  *)
    echo "usage: $0 put|verify <version-dir> <dest> | latest <file> <dest> [<dir>]" >&2
    exit 2
    ;;
esac
