#!/bin/sh
set -eu

ACDE_DIST=${ACDE_DIST:-https://pkgs.dopame.ai/acde}
ACDE_DIST=${ACDE_DIST%/}
ACDERT_DIST=${ACDERT_DIST:-https://pkgs.dopame.ai/acdert}
ACDERT_DIST=${ACDERT_DIST%/}

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

Installs acde (the developer CLI and its SDK) and the Dopame runtime it was built
with (acdert) into \$ACDE_INSTALL (default ~/.acde) and puts \$ACDE_INSTALL/bin on
PATH. No root needed. Every download is checked against its SHA256SUMS; if any part
fails, nothing is installed and an earlier install stays as it was.
  --version X.Y.Z    that version of acde (and its acdert) instead of the latest
  --no-modify-path   do not touch any shell startup file
  ACDE_DIST          where to download acde from (now $ACDE_DIST)
  ACDERT_DIST        where to download acdert from (now $ACDERT_DIST)
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
  arch=$(uname -m)
  case $arch in
    x86_64 | amd64) cpu=x86_64 ;;
    aarch64 | arm64) cpu=aarch64 ;;
    *) cpu=$arch ;;
  esac
  case $os in
    Darwin)
      if [ "$cpu" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        cpu=aarch64
      fi
      triple=$cpu-apple-darwin
      ;;
    Linux)
      libc=gnu
      if ls /lib/ld-musl-* >/dev/null 2>&1; then
        libc=musl
      fi
      triple=$cpu-unknown-linux-$libc
      ;;
    *) triple=$cpu-$(printf '%s' "$os" | tr '[:upper:]' '[:lower:]') ;;
  esac

  bar=0
  [ -t 2 ] && bar=1
  if command -v curl >/dev/null 2>&1; then
    fetch() {
      curl -fsSL "$1" -o "$2"
    }
    size_of() {
      curl -fsSIL "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
    }
    pull() {
      if [ "$bar" = 1 ]; then curl -fL --progress-bar "$1" -o "$2"; else fetch "$1" "$2"; fi
    }
  elif command -v wget >/dev/null 2>&1; then
    fetch() {
      wget -q -O "$2" "$1"
    }
    size_of() {
      wget --spider -S "$1" 2>&1 | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
    }
    if wget --help 2>&1 | grep -q -- --show-progress; then
      wget_bar='-q --show-progress --progress=bar:force:noscroll'
    else
      wget_bar=
    fi
    pull() {
      if [ "$bar" = 1 ]; then wget $wget_bar -O "$2" "$1"; else fetch "$1" "$2"; fi
    }
  else
    die "needs curl or wget to download acde"
  fi

  download() {
    bytes=$(size_of "$1")
    case $bytes in
      '' | *[!0-9]*) say "downloading $3" ;;
      *) say "downloading $3 ($(awk -v b="$bytes" 'BEGIN {
        if (b < 1048576) printf "%d KB", (b + 1023) / 1024; else printf "%.1f MB", b / 1048576 }'))" ;;
    esac
    pull "$1" "$2" || return 1
    [ "$bar" = 1 ] || say "downloaded $3"
  }

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

  listed() {
    awk -v f="$2" '$2 == f || $2 == "*" f { print $1 }' "$1"
  }

  verify() {
    say "checking $2 against its SHA256SUMS"
    expected=$(listed "$1" "$2")
    [ -n "$expected" ] || die "$2 is not in its SHA256SUMS"
    actual=$(sha256 "$3")
    [ "$actual" = "$expected" ] ||
      die "$2 does not match its checksum (expected $expected, got $actual); not installing it"
  }

  file=acde-$version.tar.gz
  say "installing acde $version"
  fetch "$ACDE_DIST/$version/SHA256SUMS" "$tmp/SHA256SUMS" ||
    die "could not download $ACDE_DIST/$version/SHA256SUMS (is there an acde $version?)"
  [ -n "$(listed "$tmp/SHA256SUMS" "$file")" ] || die "acde $version is not in its SHA256SUMS ($file)"
  download "$ACDE_DIST/$version/$file" "$tmp/$file" "$file" || die "could not download $ACDE_DIST/$version/$file"
  verify "$tmp/SHA256SUMS" "$file" "$tmp/$file"
  runtime=
  if fetch "$ACDE_DIST/$version/acdert-version" "$tmp/acdert-version" 2>/dev/null; then
    verify "$tmp/SHA256SUMS" acdert-version "$tmp/acdert-version"
    runtime=$(tr -d ' \t\r\n' <"$tmp/acdert-version")
  elif fetch "$ACDE_DIST/latest.json" "$tmp/latest.json" 2>/dev/null; then
    field() {
      tr -d '\r\n' <"$tmp/latest.json" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
    }
    if [ "$(field version)" = "$version" ]; then
      runtime=$(field sdk)
      [ -z "$runtime" ] || say "acde $version names no acdert of its own; latest.json pairs it with acdert $runtime"
    fi
  fi
  [ -n "$runtime" ] || die "acde $version does not name the acdert it runs with" \
    "(no $ACDE_DIST/$version/acdert-version, and latest.json does not describe $version): install a newer acde"
  case $runtime in
    '' | *[!0-9A-Za-z.-]*) die "acdert-version of acde $version is not a version: '$runtime'" ;;
  esac

  sums=$ACDERT_DIST/$runtime/SHA256SUMS
  say "acde $version runs with acdert $runtime: getting its build for $triple"
  fetch "$sums" "$tmp/acdert.sums" || die "could not download $sums (acde $version runs with acdert $runtime)"
  binary=acdert-$triple
  if [ -z "$(listed "$tmp/acdert.sums" "$binary")" ]; then
    supported=$(awk '{ f = $2; sub(/^\*/, "", f); if (f ~ /^acdert-/ && f !~ /^acdert-host-/) {
      sub(/^acdert-/, "", f); sub(/\.exe$/, "", f); print f } }' "$tmp/acdert.sums" | sort | tr '\n' ' ')
    die "acdert $runtime has no build for this platform ($triple); it is built for: ${supported% }"
  fi
  host=acdert-host-$runtime.tar.gz
  download "$ACDERT_DIST/$runtime/$binary" "$tmp/$binary" "$binary" ||
    die "could not download $ACDERT_DIST/$runtime/$binary"
  verify "$tmp/acdert.sums" "$binary" "$tmp/$binary"
  download "$ACDERT_DIST/$runtime/$host" "$tmp/$host" "$host" || die "could not download $ACDERT_DIST/$runtime/$host"
  verify "$tmp/acdert.sums" "$host" "$tmp/$host"

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
  cp "$tmp/$binary" "$unpacked/bin/acdert" && chmod 755 "$unpacked/bin/acdert" || die "could not place acdert"
  mkdir "$stage/host" && tar -xzf "$tmp/$host" -C "$stage/host" || die "could not unpack $host"
  [ -f "$stage/host/app/dist/broker.js" ] || die "$host does not hold app/dist/broker.js"
  mv "$stage/host/app" "$unpacked/bin/app" || die "could not place the acdert host files"
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
      *.cshrc | *.tcshrc) line="setenv PATH \"$bin:\$PATH\"" ;;
      *.nu) line="\$env.PATH = (\$env.PATH | split row (char esep) | prepend '$bin')" ;;
      *) line="export PATH=\"$shown:\$PATH\"" ;;
    esac
    if ! grep -qsF "$line" "$1"; then
      printf '\n# acde\n%s\n' "$line" >>"$1"
      say "added $shown to PATH in $1"
    fi
  }

  has_shell() {
    [ "$(basename "${SHELL:-}")" = "$1" ] || command -v "$1" >/dev/null 2>&1 ||
      grep -qs "/$1\$" /etc/shells
  }

  if [ "$modify_path" = 1 ] && [ "$on_path" = 0 ]; then
    add_to "$HOME/.profile"
    if has_shell bash; then
      add_to "$HOME/.bashrc"
      for login in .bash_profile .bash_login; do
        if [ -f "$HOME/$login" ]; then
          add_to "$HOME/$login"
          break
        fi
      done
    fi
    if has_shell zsh; then
      add_to "${ZDOTDIR:-$HOME}/.zshrc"
      add_to "${ZDOTDIR:-$HOME}/.zprofile"
    fi
    has_shell fish && add_to "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/acde.fish"
    if has_shell tcsh || has_shell csh; then
      add_to "$HOME/.cshrc"
      [ -f "$HOME/.tcshrc" ] && add_to "$HOME/.tcshrc"
    fi
    if has_shell nu; then
      nu_env=$(nu -n -c '$nu.env-path' 2>/dev/null) || nu_env=
      if [ -n "$nu_env" ]; then
        mkdir -p "$(dirname "$nu_env")" && add_to "$nu_env"
      fi
    fi
  fi

  say "installed acde $version with acdert $runtime in $root/versions/$version"
  printf '  acde    %s/acde\n' "$bin"
  printf '  acdert  %s/acdert\n' "$bin"

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
  say "for a coding agent: acde skills install (teaches Claude Code, Codex, Cursor and others to use acde)"
  if [ "$on_path" = 0 ]; then
    case $(basename "${SHELL:-sh}") in
      fish) now="fish_add_path \"$bin\"" ;;
      *) now="export PATH=\"$bin:\$PATH\"" ;;
    esac
    if [ "$modify_path" = 1 ]; then
      say "acde is on PATH in new terminals; in this one, run:"
    else
      say "$bin is not on PATH; add it to your shell's startup file, and in this terminal run:"
    fi
    printf '\n  %s\n\n' "$now"
  fi
}

main "$@"
