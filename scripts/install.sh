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

in_use() {
  for exe in /proc/[0-9]*/exe; do
    target=$(readlink "$exe" 2>/dev/null) || continue
    case $target in "$1"/*) return 0 ;; esac
  done
  commands=$(ps -axo command= 2>/dev/null) || return 1
  printf '%s\n' "$commands" | grep -F "$1/" >/dev/null
}

prune() {
  for dir in "$1"/versions/*; do
    [ -d "$dir" ] && [ ! -h "$dir" ] || continue
    name=${dir##*/}
    if [ "$name" = "$2" ] || [ "$name" = "$3" ]; then
      continue
    fi
    if in_use "$dir"; then
      say "kept acde $name ($dir): a program in it is still running; the next install removes it"
    elif rm -rf "$dir"; then
      say "removed acde $name ($dir)"
    fi
  done
}

usage() {
  cat <<EOF
usage: curl -fsSL $ACDE_DIST/install.sh | sh
       curl -fsSL $ACDE_DIST/install.sh | sh -s -- [--version X.Y.Z] [--no-modify-path]
       sh install.sh [--version X.Y.Z] [--no-modify-path]

Installs acde (the developer CLI and its SDK) and the debug runtime released with it
(acdebin-dbg) into \$ACDE_INSTALL (default ~/.acde) and puts \$ACDE_INSTALL/bin on
PATH. No root needed. Every download is checked against its SHA256SUMS; if any part
fails, nothing is installed and an earlier install stays as it was.
  --version X.Y.Z    that version of acde (and its acdebin-dbg) instead of the latest
  --no-modify-path   do not touch any shell startup file
  ACDE_DIST          where to download acde from (now $ACDE_DIST)
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

  shows=0
  if [ -t 2 ]; then
    shows=1
  fi
  if command -v curl >/dev/null 2>&1; then
    fetch() {
      curl -fsSL --connect-timeout 20 --retry 2 --speed-limit 1024 --speed-time 30 "$1" -o "$2"
    }
    size_of() {
      curl -fsSIL "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
    }
    if [ "$shows" = 1 ]; then
      pull() {
        curl -fSL --progress-bar --connect-timeout 20 --retry 2 --speed-limit 1024 --speed-time 30 "$1" -o "$2"
      }
    else
      pull() {
        fetch "$1" "$2"
      }
    fi
  elif command -v wget >/dev/null 2>&1; then
    gnu_wget=0
    if wget --help 2>&1 | grep -q -- --show-progress; then
      gnu_wget=1
    fi
    if [ "$gnu_wget" = 1 ]; then
      fetch() {
        wget -q -T 30 --tries=3 -O "$2" "$1"
      }
    else
      fetch() {
        wget -q -T 30 -O "$2" "$1"
      }
    fi
    size_of() {
      wget --spider -S "$1" 2>&1 | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
    }
    if [ "$shows" = 1 ] && [ "$gnu_wget" = 1 ]; then
      pull() {
        (cd "$(dirname "$2")" && wget -q --show-progress --progress=bar:force -T 30 --tries=3 -O "$(basename "$2")" "$1")
      }
    else
      pull() {
        fetch "$1" "$2"
      }
    fi
  else
    die "needs curl or wget to download acde"
  fi

  human() {
    awk -v b="$1" 'BEGIN { if (b >= 1048576) printf "%.1f MB", b / 1048576; else printf "%d KB", (b + 1023) / 1024 }'
  }

  size() {
    human "$(wc -c <"$1" | tr -d ' ')"
  }

  download() {
    bytes=$(size_of "$1")
    case $bytes in
      '' | *[!0-9]*) say "downloading $3" ;;
      *) say "downloading $3 ($(human "$bytes"))" ;;
    esac
    pull "$1" "$2"
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
    say "looking up the latest acde at $ACDE_DIST"
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
    expected=$(listed "$1" "$2")
    [ -n "$expected" ] || die "$2 is not in its SHA256SUMS"
    actual=$(sha256 "$3")
    [ "$actual" = "$expected" ] ||
      die "$2 does not match its checksum (expected $expected, got $actual); not installing it"
  }

  got() {
    verify "$1" "$2" "$3"
    say "$2: $(size "$3"), SHA-256 matches"
  }

  file=acde-$version.tar.gz
  say "installing acde $version"
  fetch "$ACDE_DIST/$version/SHA256SUMS" "$tmp/SHA256SUMS" ||
    die "could not download $ACDE_DIST/$version/SHA256SUMS (is there an acde $version?)"
  [ -n "$(listed "$tmp/SHA256SUMS" "$file")" ] || die "acde $version is not in its SHA256SUMS ($file)"
  download "$ACDE_DIST/$version/$file" "$tmp/$file" "$file" || die "could not download $ACDE_DIST/$version/$file"
  got "$tmp/SHA256SUMS" "$file" "$tmp/$file"
  binary=acdebin-dbg-$triple
  if [ -n "$(listed "$tmp/SHA256SUMS" "$binary.tar.xz")" ]; then
    binary=$binary.tar.xz
    tar --version 2>/dev/null | grep -q bsdtar || command -v xz >/dev/null 2>&1 ||
      die "needs xz to unpack $binary: install the xz (or xz-utils) package and run this again"
  elif [ -n "$(listed "$tmp/SHA256SUMS" "acdert-version")" ]; then
    die "acde $version comes from before acde and its runtime were released together: leave out --version for the latest"
  else
    supported=$(awk '{ f = $2; sub(/^\*/, "", f); if (f ~ /^acdebin-dbg-/) {
      sub(/^acdebin-dbg-/, "", f); sub(/\.tar\.[gx]z$/, "", f); print f } }' "$tmp/SHA256SUMS" |
      sort -u | tr '\n' ' ')
    die "acde $version has no acdebin-dbg for this platform ($triple); it is built for: ${supported% }"
  fi
  host=acde-host-$version.tar.gz
  say "getting acdebin-dbg $version for $triple"
  download "$ACDE_DIST/$version/$binary" "$tmp/$binary" "$binary" || die "could not download $ACDE_DIST/$version/$binary"
  got "$tmp/SHA256SUMS" "$binary" "$tmp/$binary"
  download "$ACDE_DIST/$version/$host" "$tmp/$host" "$host" || die "could not download $ACDE_DIST/$version/$host"
  got "$tmp/SHA256SUMS" "$host" "$tmp/$host"

  root=${ACDE_INSTALL:-$HOME/.acde}
  mkdir -p "$root/versions" || die "cannot create $root/versions"
  case $root in
    /*) ;;
    *) root=$(pwd)/$root ;;
  esac
  say "unpacking into $root/versions/$version"
  stage=$(mktemp -d "$root/versions/.stage.XXXXXX")
  trap 'rm -rf "$tmp" "$stage"' EXIT
  tar -xzf "$tmp/$file" -C "$stage" || die "could not unpack $file"
  unpacked=$stage/acde-$version
  [ -x "$unpacked/bin/acde" ] || die "$file does not hold bin/acde"
  mkdir "$stage/runtime" && tar -xJf "$tmp/$binary" -C "$stage/runtime" || die "could not unpack $binary"
  [ -f "$stage/runtime/acdebin-dbg" ] && [ ! -h "$stage/runtime/acdebin-dbg" ] || die "$binary does not hold acdebin-dbg"
  mv "$stage/runtime/acdebin-dbg" "$unpacked/bin/acdebin-dbg" && chmod 755 "$unpacked/bin/acdebin-dbg" ||
    die "could not place acdebin-dbg"
  mkdir "$stage/host" && tar -xzf "$tmp/$host" -C "$stage/host" || die "could not unpack $host"
  [ -f "$stage/host/app/dist/broker.js" ] || die "$host does not hold app/dist/broker.js"
  mv "$stage/host/app" "$unpacked/bin/app" || die "could not place the host files (app/)"
  if [ -e "$root/versions/$version" ]; then
    mv "$root/versions/$version" "$stage/old"
  fi
  mv "$unpacked" "$root/versions/$version"

  previous=$(readlink "$root/current" 2>/dev/null || true)
  previous=${previous##*/}
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
  prune "$root" "$version" "$previous"

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
      *)
        unguarded="export PATH=\"$shown:\$PATH\""
        line="case \":\$PATH:\" in *\":$shown:\"*) ;; *) $unguarded ;; esac"
        if grep -qsxF "$unguarded" "$1"; then
          updated=$(awk -v old="$unguarded" -v new="$line" '$0 == old { $0 = new } { print }' "$1") &&
            printf '%s\n' "$updated" >"$1" && say "made the acde PATH line in $1 add $shown only once"
          return
        fi
        ;;
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

  say "installed acde $version with acdebin-dbg $version in $root/versions/$version"
  printf '  acde         %s/acde\n' "$bin"
  printf '  acdebin-dbg  %s/acdebin-dbg\n' "$bin"

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
