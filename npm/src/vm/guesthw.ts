export type GuestHardware = 'wifi' | 'bluetooth' | 'battery'

export const GUEST_HARDWARE: readonly GuestHardware[] = ['wifi', 'bluetooth', 'battery']

export const WIFI = { open: 'acdev-open', secured: 'acdev-wpa2', password: 'acdev-wifi-pass' } as const

export const PEER_NAME = 'acdev-peer'

const WIFI_SCRIPT = [
  '#!/bin/bash',
  'set -eo pipefail',
  `open=${WIFI.open} secured=${WIFI.secured} password=${WIFI.password}`,
  'run=/run/acdev-wifi',
  'say() { echo "acdev-wifi: $*"; }',
  'fail() { echo "acdev-wifi: $*" >&2; exit 4; }',
  'hwsim() { [ "$(basename "$(readlink -f "$1/device/driver")")" = mac80211_hwsim ]; }',
  'radios() { for phy in /sys/class/ieee80211/*; do if hwsim "$phy"; then ls "$phy/device/net"; fi; done 2>/dev/null | sort; }',
  'up() {',
  '  modinfo mac80211_hwsim >/dev/null 2>&1 || fail "this kernel has no mac80211_hwsim module (CONFIG_MAC80211_HWSIM=m)"',
  '  command -v hostapd >/dev/null || fail "hostapd is not installed: run acdev vm provision (without --no-wifi)"',
  '  [ -f "$run/hostapd.pid" ] && { say "already up"; return; }',
  '  modprobe mac80211_hwsim radios=2',
  '  for _ in $(seq 50); do [ "$(radios | wc -l)" -ge 2 ] && break; sleep 0.1; done',
  '  count=$(radios | wc -l)',
  '  [ "$count" -ge 2 ] || fail "mac80211_hwsim made $count interfaces, not 2"',
  '  ap=$(radios | sed -n 1p) station=$(radios | sed -n 2p)',
  '  mkdir -p "$run"',
  '  nmcli device set "$ap" managed no 2>/dev/null || true',
  '  mac=$(cat "/sys/class/net/$ap/address")',
  '  last=$(echo "$mac" | cut -d: -f6) first=$(echo "$mac" | cut -d: -f1-5) extra="$ap"_1',
  '  second=$(printf "%s:%02x" "$first" $(( (0x$last + 1) % 256 )))',
  '  cat >"$run/hostapd.conf" <<EOF',
  'interface=$ap',
  'driver=nl80211',
  'ctrl_interface=/run/hostapd',
  'hw_mode=g',
  'channel=6',
  'ssid=$open',
  'bss=$extra',
  'bssid=$second',
  'ssid=$secured',
  'wpa=2',
  'wpa_key_mgmt=WPA-PSK',
  'rsn_pairwise=CCMP',
  'wpa_passphrase=$password',
  'EOF',
  '  hostapd -B -P "$run/hostapd.pid" "$run/hostapd.conf" >"$run/hostapd.log" 2>&1 || fail "hostapd did not start: $(tail -n 3 "$run/hostapd.log")"',
  '  nmcli device set "$station" managed yes 2>/dev/null || true',
  '  nmcli device wifi rescan ifname "$station" 2>/dev/null || true',
  '  say "up: $ap sends $open (open) and $secured (WPA2, $password); NetworkManager manages $station"',
  '}',
  'down() {',
  '  [ -f "$run/hostapd.pid" ] && kill "$(cat "$run/hostapd.pid")" 2>/dev/null || true',
  '  rm -rf "$run"',
  '  modprobe -r mac80211_hwsim 2>/dev/null || true',
  '  say "down"',
  '}',
  'case "$1" in',
  '  up) up ;;',
  '  down) down ;;',
  '  *) echo "usage: acdev-wifi up|down" >&2; exit 2 ;;',
  'esac',
  '',
].join('\n')

const BLUETOOTH_SCRIPT = [
  '#!/bin/bash',
  'set -eo pipefail',
  `peer=${PEER_NAME}`,
  'run=/run/acdev-bt',
  'say() { echo "acdev-bt: $*"; }',
  'fail() { echo "acdev-bt: $*" >&2; exit 4; }',
  'btvirt() {',
  '  for exe in "$(command -v btvirt 2>/dev/null)" /usr/lib/bluez/btvirt /usr/libexec/bluetooth/btvirt; do',
  '    if [ -x "$exe" ]; then echo "$exe"; return; fi',
  '  done',
  '}',
  'controllers() { ls /sys/class/bluetooth 2>/dev/null | grep -c "^hci[0-9]*$" || true; }',
  'up() {',
  '  modinfo hci_vhci >/dev/null 2>&1 || fail "this kernel has no hci_vhci module (CONFIG_BT_HCIVHCI=m)"',
  '  exe=$(btvirt)',
  '  [ -n "$exe" ] || fail "no btvirt (BlueZ built with --enable-testing has it; bluez-utils here does not): no virtual controller"',
  '  [ -f "$run/btvirt.pid" ] && { say "already up"; return; }',
  '  mkdir -p "$run"',
  '  modprobe hci_vhci',
  '  before=$(controllers)',
  '  setsid "$exe" -l2 >"$run/btvirt.log" 2>&1 < /dev/null &',
  '  echo $! >"$run/btvirt.pid"',
  '  for _ in $(seq 50); do [ "$(controllers)" -ge $((before + 2)) ] && break; sleep 0.1; done',
  '  [ "$(controllers)" -ge $((before + 2)) ] || fail "btvirt made no controllers: $(tail -n 3 "$run/btvirt.log")"',
  '  systemctl start bluetooth',
  '  last=$(ls /sys/class/bluetooth | grep "^hci[0-9]*$" | sort -V | tail -n 1)',
  '  index=$(echo "$last" | sed "s/^hci//")',
  '  sleep 1',
  '  btmgmt --index "$index" power on >/dev/null 2>&1 || true',
  '  btmgmt --index "$index" name "$peer" >/dev/null 2>&1 || true',
  '  btmgmt --index "$index" connectable on >/dev/null 2>&1 || true',
  '  btmgmt --index "$index" discov on >/dev/null 2>&1 || true',
  '  say "up: bluetoothd has the virtual controllers; $last is the discoverable device $peer"',
  '}',
  'down() {',
  '  [ -f "$run/btvirt.pid" ] && kill "$(cat "$run/btvirt.pid")" 2>/dev/null || true',
  '  rm -rf "$run"',
  '  sleep 0.5',
  '  modprobe -r hci_vhci 2>/dev/null || true',
  '  say "down"',
  '}',
  'case "$1" in',
  '  up) up ;;',
  '  down) down ;;',
  '  *) echo "usage: acdev-bt up|down" >&2; exit 2 ;;',
  'esac',
  '',
].join('\n')

const BATTERY_SCRIPT = [
  '#!/bin/bash',
  'set -eo pipefail',
  'params=/sys/module/test_power/parameters',
  'say() { echo "acdev-battery: $*"; }',
  'fail() { echo "acdev-battery: $*" >&2; exit 4; }',
  'usage() { echo "usage: acdev-battery PERCENT [charging|discharging] | off" >&2; exit 2; }',
  'action() { sed -n "s/^PercentageAction=\\([0-9]*\\).*/\\1/p" /etc/UPower/UPower.conf 2>/dev/null | tail -n 1 || true; }',
  'if [ "$1" = off ]; then',
  '  modprobe -r test_power 2>/dev/null || true',
  '  say "the simulated battery is gone"',
  '  exit 0',
  'fi',
  'percent=$1 state=$2',
  '[ -n "$state" ] || state=discharging',
  '[[ "$percent" =~ ^[0-9]+$ ]] && [ "$percent" -le 100 ] || usage',
  'case "$state" in charging|discharging) ;; *) usage ;; esac',
  'floor=$(action)',
  '[ -n "$floor" ] || floor=2',
  'if [ "$state" = discharging ] && [ "$percent" -le "$floor" ]; then',
  '  fail "$percent% is at or below UPower\'s PercentageAction ($floor%): UPower would act on it (CriticalPowerAction); use $((floor + 1)) or more"',
  'fi',
  'modinfo test_power >/dev/null 2>&1 || fail "this kernel has no test_power module (CONFIG_TEST_POWER=m)"',
  'command -v upower >/dev/null || fail "UPower is not installed: run acdev vm provision (without --no-battery)"',
  '[ -d "$params" ] || modprobe test_power',
  'echo "$([ "$state" = charging ] && echo on || echo off)" >"$params/ac_online"',
  'echo "$state" >"$params/battery_status"',
  'echo "$percent" >"$params/battery_capacity"',
  'systemctl start upower 2>/dev/null || true',
  'say "battery $percent%, $state"',
  '',
].join('\n')

interface Part {
  readonly script: string
  readonly text: string
  readonly packages: readonly string[]
  readonly after: string
  readonly start: string
  readonly stop: string
}

const PARTS: Readonly<Record<GuestHardware, Part>> = {
  wifi: { script: 'acdev-wifi', text: WIFI_SCRIPT, packages: ['hostapd', 'iw'], after: 'NetworkManager.service', start: 'up', stop: 'down' },
  bluetooth: { script: 'acdev-bt', text: BLUETOOTH_SCRIPT, packages: ['bluez', 'bluez-utils'], after: 'bluetooth.service', start: 'up', stop: 'down' },
  battery: { script: 'acdev-battery', text: BATTERY_SCRIPT, packages: ['upower'], after: 'upower.service', start: '100 charging', stop: 'off' },
}

export const MISSING = 4

export function unitName(name: GuestHardware): string {
  return `${PARTS[name].script}.service`
}

export function unitText(name: GuestHardware): string {
  const { script, after, start, stop } = PARTS[name]
  return [
    '[Unit]',
    `Description=acdev: the simulated ${name === 'wifi' ? 'Wi-Fi' : name} (${script})`,
    `Wants=${after}`,
    `After=${after}`,
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=/usr/local/bin/${script} ${start}`,
    `ExecStop=/usr/local/bin/${script} ${stop}`,
    `SuccessExitStatus=${MISSING}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

export function guestHardware(flags: ReadonlyMap<string, string>): { readonly on: GuestHardware[]; readonly off: GuestHardware[] } {
  const off = GUEST_HARDWARE.filter((name) => flags.has(`no-${name}`))
  return { on: GUEST_HARDWARE.filter((name) => !off.includes(name)), off }
}

export interface HardwareFiles {
  readonly scripts: Record<string, string>
  readonly units: Record<string, string>
  readonly packages: string[]
  readonly off: string[]
}

export function hardwareFiles(on: readonly GuestHardware[], off: readonly GuestHardware[] = []): HardwareFiles {
  const scripts: Record<string, string> = {}
  const units: Record<string, string> = {}
  const packages = new Set<string>()
  for (const name of on) {
    const { script, text, packages: needed } = PARTS[name]
    scripts[script] = text
    units[unitName(name)] = unitText(name)
    for (const pkg of needed) packages.add(pkg)
  }
  return { scripts, units, packages: [...packages], off: off.map(unitName) }
}
