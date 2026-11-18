#!/bin/sh
# Rust for the CI runners, run as root in each ci-debian container: rustup's stable in /opt/rust, owned by root, so the jobs
# (two at once per runner, each with its own HOME and CARGO_HOME) read it and none changes it. Run again to update, while the runner is idle.
set -eu
export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
targets=x86_64-unknown-linux-gnu,aarch64-unknown-linux-gnu,x86_64-unknown-linux-musl,aarch64-unknown-linux-musl,x86_64-pc-windows-msvc,x86_64-apple-darwin,aarch64-apple-darwin
mkdir -p /opt/rust
if [ -x "$CARGO_HOME/bin/rustup" ]; then
  "$CARGO_HOME/bin/rustup" update stable
  "$CARGO_HOME/bin/rustup" target add --toolchain stable $(echo "$targets" | tr ',' ' ')
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable -c clippy,rustfmt -t "$targets"
fi
chown -R root:root /opt/rust && chmod -R go-w /opt/rust
"$CARGO_HOME/bin/rustc" -V
