#!/bin/sh
set -eu

ACDE_DIST=${ACDE_DIST:-https://pkgs.dopame.ai/acde}
ACDE_DIST=${ACDE_DIST%/}

say() {
  printf 'acde-install: %s\n' "$*"
}

die() {
  printf 'acde-install: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
usage: curl -fsSL $ACDE_DIST/install.sh | sh
       curl -fsSL $ACDE_DIST/install.sh | sh -s -- [--version X.Y.Z] [--no-modify-path]
       sh install.sh [--version X.Y.Z] [--no-modify-path]

Installs acde (the developer CLI and its SDK) into \$ACDE_INSTALL (default ~/.acde)
and puts \$ACDE_INSTALL/bin on PATH. No root needed. The runtime (acdert) is not
part of acde: acde dev finds it through ACDERT or PATH.
  --version X.Y.Z    that version instead of the latest
  --no-modify-path   do not touch any shell startup file
  ACDE_DIST          where to download from (now $ACDE_DIST)
EOF
}

main() {
  version=
  modify_path=1
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a value, like --version 0.0.3"
        version=$2
        shift 2
        ;;
      --version=*)
        version=${1#--version=}
        shift
        ;;
      --no-modify-path)
        modify_path=0
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown argument: $1"
        ;;
    esac
  done

  [ -n "${HOME:-}" ] || die "HOME is not set"

  os=$(uname -s)
  case $os in
    MINGW* | MSYS* | CYGWIN*) die "this is Windows: in PowerShell run  irm $ACDE_DIST/install.ps1 | iex" ;;
  esac

  if command -v curl >/dev/null 2>&1; then
    fetch() {
      curl -fsSL "$1" -o "$2"
    }
  elif command -v wget >/dev/null 2>&1; then
    fetch() {
      wget -q -O "$2" "$1"
    }
  else
    die "needs curl or wget to download acde"
  fi

  if command -v shasum >/dev/null 2>&1; then
    sha256() {
      shasum -a 256 "$1" | cut -d ' ' -f 1
    }
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256() {
      sha256sum "$1" | cut -d ' ' -f 1
    }
  elif command -v openssl >/dev/null 2>&1; then
    sha256() {
      openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
    }
  else
    die "needs shasum, sha256sum or openssl to verify the download"
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t acde-install)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM HUP

  if [ -z "$version" ]; then
    fetch "$ACDE_DIST/latest" "$tmp/latest" || die "could not download $ACDE_DIST/latest (is ACDE_DIST right?)"
    version=$(tr -d ' \t\r\n' <"$tmp/latest")
  fi
  case $version in
    '' | *[!0-9A-Za-z.-]*) die "not a version: '$version'" ;;
  esac

  file=acde-$version.tar.gz
  say "downloading acde $version"
  fetch "$ACDE_DIST/$version/SHA256SUMS" "$tmp/SHA256SUMS" ||
    die "could not download $ACDE_DIST/$version/SHA256SUMS (is there an acde $version?)"
  expected=$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || die "acde $version is not in its SHA256SUMS ($file)"
  fetch "$ACDE_DIST/$version/$file" "$tmp/$file" || die "could not download $ACDE_DIST/$version/$file"
  actual=$(sha256 "$tmp/$file")
  [ "$actual" = "$expected" ] ||
    die "$file does not match its checksum (expected $expected, got $actual); not installing it"

  root=${ACDE_INSTALL:-$HOME/.acde}
  mkdir -p "$root/versions" || die "cannot create $root/versions"
  case $root in
    /*) ;;
    *) root=$(pwd)/$root ;;
  esac
  stage=$(mktemp -d "$root/versions/.stage.XXXXXX")
  trap 'rm -rf "$tmp" "$stage"' EXIT
  tar -xzf "$tmp/$file" -C "$stage" || die "could not unpack $file"
  unpacked=$stage/acde-$version
  [ -x "$unpacked/bin/acde" ] || die "$file does not hold bin/acde"
  if [ -e "$root/versions/$version" ]; then
    mv "$root/versions/$version" "$stage/old"
  fi
  mv "$unpacked" "$root/versions/$version"

  ln -s "versions/$version" "$root/.current.$$"
  mv -T "$root/.current.$$" "$root/current" 2>/dev/null ||
    mv -h "$root/.current.$$" "$root/current" 2>/dev/null || {
    rm -f "$root/.current.$$"
    ln -sfn "versions/$version" "$root/current"
  }
  if [ -h "$root/bin" ] || [ ! -e "$root/bin" ]; then
    ln -sfn current/bin "$root/bin"
  else
    die "$root/bin is in the way (it should be a link to current/bin): move it and run this again"
  fi
  bin=$root/bin

  case $bin in
    "$HOME"/*) shown="\$HOME${bin#"$HOME"}" ;;
    *) shown=$bin ;;
  esac

  added=
  on_path=0
  case ":${PATH:-}:" in
    *":$bin:"*) on_path=1 ;;
  esac

  add_to() {
    case $1 in
      *.fish)
        line="fish_add_path -g \"$bin\""
        mkdir -p "$(dirname "$1")"
        ;;
      *) line="export PATH=\"$shown:\$PATH\"" ;;
    esac
    if ! grep -qsF "$line" "$1"; then
      printf '\n# acde\n%s\n' "$line" >>"$1"
      added=1
      say "added $shown to PATH in $1"
    fi
  }

  if [ "$modify_path" = 1 ] && [ "$on_path" = 0 ]; then
    case $(basename "${SHELL:-sh}") in
      zsh) add_to "${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash)
        add_to "$HOME/.bashrc"
        if [ "$os" = Darwin ]; then
          add_to "$HOME/.bash_profile"
        fi
        ;;
      fish) add_to "$HOME/.config/fish/conf.d/acde.fish" ;;
      *) add_to "$HOME/.profile" ;;
    esac
  fi

  say "installed acde $version in $root/versions/$version"
  printf '  acde    %s/acde\n' "$bin"
  if [ -n "$added" ]; then
    say "open a new terminal (or run: export PATH=\"$bin:\$PATH\") to get acde on PATH"
  elif [ "$on_path" = 0 ]; then
    say "$bin is not on PATH in this shell; add it: export PATH=\"$bin:\$PATH\""
  fi

  runs=
  if command -v bun >/dev/null 2>&1; then
    bun_version=$(bun --version 2>/dev/null || true)
    case $bun_version in
      1.[4-9]* | [2-9].* | [1-9][0-9]*) runs=bun ;;
      *)
        say "acde needs Bun 1.4 or newer, and the bun on PATH is $bun_version:" \
          "update it (bun upgrade, or https://bun.sh)"
        ;;
    esac
  fi
  if [ -z "$runs" ] && command -v node >/dev/null 2>&1; then
    node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
    node_minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || true)
    case $node_major in
      '' | *[!0-9]*) node_major=0 ;;
    esac
    case $node_minor in
      '' | *[!0-9]*) node_minor=0 ;;
    esac
    if [ "$node_major" -gt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 3 ]; }; then
      runs=node
    else
      say "acde needs Node.js 22.3 or newer, and the node on PATH is $(node --version 2>/dev/null):" \
        "update it (https://nodejs.org)"
    fi
  fi
  if [ -z "$runs" ]; then
    say "acde runs on Bun 1.4 or newer, or Node.js 22.3 or newer, and found neither:" \
      "install Bun (https://bun.sh) or Node.js (https://nodejs.org)"
  fi
  say "next: acde new my-app (it uses your bun, or npm / pnpm / yarn on Node.js)"
}

main "$@"
