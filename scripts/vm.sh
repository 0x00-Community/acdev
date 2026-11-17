#!/usr/bin/env bash
# Dopame OS guest under QEMU (KVM on Linux hosts); see docs/vm.md.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
state=${ACDEV_VM_DIR:-$root/.vm}
logs=$root/logs/vm
images=$state/images
run=$state/run
dist=${ACDEV_VM_DIST:-https://calbin-1318886512.cos.ap-beijing.myqcloud.com/iso}
mount_tag=acdev
guest_share=/mnt/acdev

say() { printf 'vm: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage: scripts/vm.sh fetch                      download the newest Dopame OS x86_64 disk image
       scripts/vm.sh start [options]            boot the guest in the background
         --image FILE      base disk image (qcow2; default: the newest fetched)
         --fresh           drop the guest's changes (the overlay disk and UEFI variables) first
         --share DIR       export DIR to the guest over 9p (tag acdev; scripts/vm.sh mount)
         --headless        no window (screenshots still work)
         --vnc             a VNC display on 127.0.0.1:5900 instead of a window
         --gl              virtio-vga-gl with an OpenGL window (virgl)
         --kernel FILE     boot this kernel directly (with --initrd and --append, root= included)
         --initrd FILE
         --append TEXT     kernel command line for --kernel; console=ttyS0 is added
       scripts/vm.sh stop                       power the guest off (ACPI, then kill after 60 s)
       scripts/vm.sh status
       scripts/vm.sh wait [SECONDS]             until the guest agent answers (default 300)
       scripts/vm.sh run COMMAND...             run COMMAND as root in the guest (sh -c), print its output
       scripts/vm.sh push LOCAL [REMOTE]        copy a file or directory into the guest (default /opt/acdev/<name>)
       scripts/vm.sh mount                      mount the --share directory at /mnt/acdev in the guest
       scripts/vm.sh console                    send the guest kernel's messages to the serial log from the next boot
       scripts/vm.sh screenshot FILE.png
       scripts/vm.sh logs                       follow the serial log
EOF
  exit 2
}

bun_bin() { command -v bun || die 'bun not found (scripts/vm-agent.ts runs on bun)'; }
agent() { "$(bun_bin)" "$root/scripts/vm-agent.ts" "$@"; }
qmp() { agent qmp "$run/qmp.sock" "$@"; }
ga() { agent ga "$run/qga.sock" "$@"; }

pid() { [[ -f $run/qemu.pid ]] && kill -0 "$(cat "$run/qemu.pid")" 2>/dev/null && cat "$run/qemu.pid"; }
need_running() { pid >/dev/null || die 'the guest is not running (scripts/vm.sh start)'; }

firmware() {
  local code vars pair
  for pair in \
    /usr/share/OVMF/OVMF_CODE_4M.fd:/usr/share/OVMF/OVMF_VARS_4M.fd \
    /usr/share/edk2/x64/OVMF_CODE.4m.fd:/usr/share/edk2/x64/OVMF_VARS.4m.fd \
    /usr/share/edk2/ovmf/OVMF_CODE.fd:/usr/share/edk2/ovmf/OVMF_VARS.fd \
    /usr/share/OVMF/OVMF_CODE.fd:/usr/share/OVMF/OVMF_VARS.fd \
    /usr/share/qemu/edk2-x86_64-code.fd:/usr/share/qemu/edk2-i386-vars.fd; do
    code=${pair%%:*} vars=${pair#*:}
    [[ -f $code && -f $vars ]] && { printf '%s\n%s\n' "$code" "$vars"; return; }
  done
  [[ -n ${OVMF_CODE:-} && -n ${OVMF_VARS:-} ]] && { printf '%s\n%s\n' "$OVMF_CODE" "$OVMF_VARS"; return; }
  die 'no UEFI firmware: install OVMF (ovmf / edk2-ovmf) or set OVMF_CODE and OVMF_VARS'
}

fetch() {
  mkdir -p "$images"
  local name
  name=$(curl -fsS --connect-timeout 20 "$dist/latest-qcow2") || die "cannot read $dist/latest-qcow2"
  name=${name//[$'\r\n ']/}
  if [[ -f $images/$name ]]; then
    say "$name is already here"
  else
    say "downloading $dist/$name"
    curl -fL --connect-timeout 20 --retry 2 -o "$images/$name.part" "$dist/$name"
    curl -fsS -o "$images/$name.sha256" "$dist/$name.sha256"
    (cd "$images" && sha256sum -c <(sed "s|  .*|  $name.part|" "$name.sha256")) >/dev/null || die "$name: SHA-256 does not match"
    mv "$images/$name.part" "$images/$name"
    say "$name: SHA-256 matches"
  fi
  ln -sfn "$name" "$images/latest.qcow2"
  printf '%s\n' "$images/$name"
}

start() {
  local image='' fresh=0 share='' display=window gl=0 kernel='' initrd='' append=''
  while (($#)); do
    case $1 in
      --image) image=$2; shift ;;
      --fresh) fresh=1 ;;
      --share) share=$(cd -- "$2" && pwd -P); shift ;;
      --headless) display=none ;;
      --vnc) display=vnc ;;
      --gl) gl=1 ;;
      --kernel) kernel=$2; shift ;;
      --initrd) initrd=$2; shift ;;
      --append) append=$2; shift ;;
      *) usage ;;
    esac
    shift
  done
  pid >/dev/null && die "already running (pid $(pid))"
  command -v qemu-system-x86_64 >/dev/null || die 'qemu-system-x86_64 not found (install qemu-system-x86 and qemu-utils)'
  command -v qemu-img >/dev/null || die 'qemu-img not found'
  image=${image:-$images/latest.qcow2}
  [[ -f $image ]] || die "no disk image $image (scripts/vm.sh fetch, or --image)"
  image=$(realpath -- "$image")
  mkdir -p "$run" "$logs"
  local fw code vars
  fw=$(firmware)
  code=$(sed -n 1p <<<"$fw") vars=$(sed -n 2p <<<"$fw")
  if ((fresh)) || [[ ! -f $state/disk.qcow2 || $(cat "$state/disk.base" 2>/dev/null) != "$image" ]]; then
    rm -f "$state/disk.qcow2" "$state/vars.fd"
    qemu-img create -q -f qcow2 -b "$image" -F qcow2 "$state/disk.qcow2"
    printf '%s\n' "$image" >"$state/disk.base"
    say "new overlay disk on $image"
  fi
  [[ -f $state/vars.fd ]] || cp -- "$vars" "$state/vars.fd"

  local accel=(-accel tcg,thread=multi -cpu max)
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then
    accel=(-accel kvm -cpu host)
  else
    say 'cannot open /dev/kvm: emulating (TCG), much slower'
  fi
  local args=(
    -name acdev -machine q35 "${accel[@]}" -smp "${ACDEV_VM_CPUS:-4}" -m "${ACDEV_VM_MEMORY:-8G}"
    -drive "if=pflash,format=raw,readonly=on,file=$code"
    -drive "if=pflash,format=raw,file=$state/vars.fd"
    -drive "file=$state/disk.qcow2,format=qcow2,if=none,id=hd0" -device virtio-blk-pci,drive=hd0,bootindex=1
    -device virtio-keyboard-pci -device virtio-tablet-pci
    -nic user,model=virtio-net-pci
    -chardev "socket,path=$run/qga.sock,server=on,wait=off,id=qga0"
    -device virtio-serial -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0
    -qmp "unix:$run/qmp.sock,server=on,wait=off"
    -chardev "file,id=serial0,path=$logs/serial.log" -serial chardev:serial0
    -pidfile "$run/qemu.pid"
  )
  if ((gl)); then
    [[ $display == window ]] || die "--gl needs a window"
    args+=(-device virtio-vga-gl -display gtk,gl=on)
  else
    args+=(-device virtio-vga)
    case $display in
      window) args+=(-display gtk) ;;
      none) args+=(-display none) ;;
      vnc) args+=(-display vnc=127.0.0.1:0) ;;
    esac
  fi
  [[ -n $share ]] && args+=(-virtfs "local,path=$share,mount_tag=$mount_tag,security_model=none,id=share0")
  if [[ -n $kernel ]]; then
    args+=(-kernel "$kernel" -append "${append:+$append }console=tty0 console=ttyS0,115200")
    [[ -n $initrd ]] && args+=(-initrd "$initrd")
  fi
  printf '%q ' qemu-system-x86_64 "${args[@]}" >"$logs/qemu.cmd"
  : >"$logs/serial.log"
  rm -f "$run/qga.sock" "$run/qmp.sock" "$run/qemu.pid"
  setsid qemu-system-x86_64 "${args[@]}" >"$logs/qemu.log" 2>&1 </dev/null &
  local i
  for ((i = 0; i < 50; i++)); do
    [[ -f $run/qemu.pid ]] && break
    kill -0 $! 2>/dev/null || { cat "$logs/qemu.log" >&2; die 'qemu exited'; }
    sleep 0.2
  done
  printf '%s\n' "${share:-}" >"$run/share"
  say "running (pid $(cat "$run/qemu.pid")); serial log $logs/serial.log, qemu log $logs/qemu.log"
}

stop() {
  local p i
  p=$(pid) || { say 'not running'; return 0; }
  qmp system_powerdown >/dev/null 2>&1 || true
  for ((i = 0; i < 60; i++)); do
    kill -0 "$p" 2>/dev/null || { say 'powered off'; rm -f "$run/qemu.pid"; return 0; }
    sleep 1
  done
  say 'no power-off in 60 s: killing qemu'
  kill "$p"
  rm -f "$run/qemu.pid"
}

push() {
  local local_path=$1 remote=${2:-/opt/acdev/$(basename -- "$1")} tmp
  [[ -e $local_path ]] || die "no $local_path"
  need_running
  if [[ -d $local_path ]]; then
    tmp=$(mktemp "${TMPDIR:-/tmp}/acdev-vm.XXXXXX")
    tar -C "$local_path" -cf "$tmp" .
    ga push "$tmp" /tmp/acdev-push.tar
    rm -f "$tmp"
    ga exec 120 "mkdir -p '$remote' && tar -xf /tmp/acdev-push.tar -C '$remote' && rm -f /tmp/acdev-push.tar"
  else
    ga exec 30 "mkdir -p '$(dirname -- "$remote")'"
    ga push "$local_path" "$remote"
    [[ -x $local_path ]] && ga exec 30 "chmod +x '$remote'"
  fi
  say "$local_path -> guest:$remote"
}

case ${1:-} in
  fetch) fetch ;;
  start) shift; start "$@" ;;
  stop) stop ;;
  status)
    if p=$(pid); then
      say "running (pid $p)"
      ga ping 0 >/dev/null 2>&1 && say 'guest agent answers' || say 'guest agent not up yet'
    else
      say 'not running'
    fi ;;
  wait) need_running; ga ping "${2:-300}" ;;
  run) shift; (($#)) || usage; need_running; ga exec "${ACDEV_VM_TIMEOUT:-600}" "$*" ;;
  push) shift; (($#)) || usage; push "$@" ;;
  mount)
    need_running
    [[ -n $(cat "$run/share" 2>/dev/null) ]] || die 'started without --share'
    opts=trans=virtio,version=9p2000.L,msize=1048576
    ga exec 60 "modprobe 9pnet_virtio 9p 2>/dev/null; mkdir -p $guest_share &&
      { mountpoint -q $guest_share || mount -t 9p -o $opts $mount_tag $guest_share; }"
    say "guest:$guest_share is $(cat "$run/share")" ;;
  console)
    need_running
    ga exec 60 'for f in /boot/loader/entries/*.conf /efi/loader/entries/*.conf /boot/efi/loader/entries/*.conf; do
      [ -f "$f" ] || continue
      grep -q "console=ttyS0" "$f" || sed -i "s/^options /options console=tty0 console=ttyS0,115200 /" "$f"
      echo "$f"
    done'
    say 'from the next boot the kernel logs to the serial log too' ;;
  screenshot) [[ -n ${2:-} ]] || usage; need_running; qmp screendump "{\"filename\":\"$(realpath -m -- "$2")\",\"format\":\"png\"}" >/dev/null; say "$2" ;;
  logs) tail -F "$logs/serial.log" ;;
  *) usage ;;
esac
