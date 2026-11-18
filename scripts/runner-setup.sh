#!/bin/sh
# The toolchains of a ci-debian runner (run as root inside the container; again to update, while the runner is idle).
# Runners keep toolchains only, read-only to the jobs: Debian packages; Rust in /opt/rust (RUSTUP_HOME=/opt/rust/rustup,
# the workflows set it); bun, cargo-xwin, cargo-zigbuild, zig and the macOS SDK in /opt/cross. Commands are linked into
# /usr/local/bin, so no job installs anything. cargo's downloads and the MSVC and zig caches stay in the runner's home.
set -eu
apt-get -o DPkg::Lock::Timeout=600 update -qq
apt-get -o DPkg::Lock::Timeout=600 install -y -qq --no-install-recommends \
  ca-certificates curl git unzip xz-utils jq awscli rsync openssh-client python3 python3-venv \
  clang lld llvm pkg-config libssl-dev libdrm-dev libgbm-dev libinput-dev libudev-dev libpipewire-0.3-dev libspa-0.2-dev \
  libwayland-dev libxkbcommon-dev libfontconfig-dev libglib2.0-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  mesa-vulkan-drivers libvulkan1 libegl1 libgl1-mesa-dri fonts-dejavu-core fonts-liberation2 fonts-noto-cjk

export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
targets=x86_64-unknown-linux-gnu,aarch64-unknown-linux-gnu,x86_64-unknown-linux-musl,aarch64-unknown-linux-musl,x86_64-pc-windows-msvc,x86_64-apple-darwin,aarch64-apple-darwin
if [ -x "$CARGO_HOME/bin/rustup" ]; then
  "$CARGO_HOME/bin/rustup" update stable
  "$CARGO_HOME/bin/rustup" target add --toolchain stable $(echo "$targets" | tr , ' ')
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable -c clippy,rustfmt -t "$targets"
fi

c=/opt/cross
get() { curl -sSfL -o "$t/$(basename "$1")" "$1" && echo "$2  $t/$(basename "$1")" | sha256sum -c --quiet -; }
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
rm -rf "$c.new" && mkdir -p "$c.new/bin"
case $(uname -m) in
  x86_64)
    get https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
    get https://github.com/rust-cross/cargo-xwin/releases/download/v0.23.1/cargo-xwin-v0.23.1.x86_64-unknown-linux-musl.tar.gz c492c6dfb7e5ac0eee586b796e0fc950ba13077e7f0bbb046f445d71790d5360
    get https://github.com/rust-cross/cargo-zigbuild/releases/download/v0.24.1/cargo-zigbuild-x86_64-unknown-linux-musl.tar.xz f09b180a517af0e4dd4bffc921bb88e5ab705452a9dd948c61e489b3020c68c2
    get https://ziglang.org/download/0.17.1/zig-x86_64-linux-0.17.1.tar.xz 3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a
    tar -xzf "$t"/cargo-xwin-*.tar.gz -C "$c.new/bin" ;;
  aarch64)
    get https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
    get https://github.com/rust-cross/cargo-zigbuild/releases/download/v0.24.1/cargo-zigbuild-aarch64-unknown-linux-gnu.tar.xz 70bb4c9cc71a6d16211b9079996e3cd588671053312adeff4d043499ed887601
    get https://ziglang.org/download/0.17.1/zig-aarch64-linux-0.17.1.tar.xz a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795 ;;
esac
get https://github.com/joseluisq/macosx-sdks/releases/download/15.5/MacOSX15.5.sdk.tar.xz c15cf0f3f17d714d1aa5a642da8e118db53d79429eb015771ba816aa7c6c1cbd
unzip -qj "$t"/bun-linux-*.zip '*/bun' -d "$c.new/bin"
mkdir "$t/zb" && tar -xJf "$t"/cargo-zigbuild-*.tar.xz -C "$t/zb" && find "$t/zb" -name cargo-zigbuild -type f -exec cp {} "$c.new/bin/" \;
tar -xJf "$t"/zig-*.tar.xz -C "$c.new" && mv "$c.new"/zig-*-0.17.1 "$c.new/zig" && ln -s ../zig/zig "$c.new/bin/zig"
tar -xJf "$t/MacOSX15.5.sdk.tar.xz" -C "$c.new"
rm -rf "$c.old" && { [ ! -e "$c" ] || mv "$c" "$c.old"; } && mv "$c.new" "$c" && rm -rf "$c.old"

chown -R root:root /opt/rust "$c" && chmod -R go-w /opt/rust "$c"
for f in /opt/rust/cargo/bin/* "$c"/bin/*; do ln -sf "$f" "/usr/local/bin/$(basename "$f")"; done
ln -sf bun /usr/local/bin/bunx
rustc -V && bun --version && zig version && command -v cargo-zigbuild && { [ "$(uname -m)" != x86_64 ] || command -v cargo-xwin; }
