#!/usr/bin/env dash
# Build the acdert package in a throwaway Arch Linux container (for hosts without Arch): installs the build
# dependencies, runs makepkg as an unprivileged user on the committed HEAD, and leaves the package in OUT.
#   packaging/arch/podman-build.sh [OUT]          (default OUT: ./out)
# Cargo and bun caches live in the podman volumes acdert-cargo and acdert-bun between runs.
set -eu
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
out=$(realpath -m "${1:-out}")
mkdir -p -- "$out"
image=${ACDE_ARCH_IMAGE:-docker.io/library/archlinux:base-devel}
podman run --rm \
  -v "$repo:/src:ro" -v "$out:/out" \
  -v acdert-cargo:/home/builder/.cargo -v acdert-bun:/home/builder/.bun \
  "$image" sh -eu -c '
    pacman -Syu --noconfirm --needed git rust bun clang cmake pkgconf python \
      mesa libdrm libinput seatd systemd-libs wayland libxkbcommon vulkan-icd-loader fontconfig >/dev/null
    id builder >/dev/null 2>&1 || useradd -m builder
    chown -R builder: /home/builder /out
    su builder -c "
      set -eu
      export BUILDDIR=/tmp/build SRCDEST=/tmp/sources PKGDEST=/out SRCPKGDEST=/out LOGDEST=/out
      mkdir -p /tmp/sources
      cd /src/packaging/arch
      makepkg --nodeps --force --cleanbuild --log
    "
  '
ls -l -- "$out"/*.pkg.tar.zst
