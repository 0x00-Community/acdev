import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLUEZ_CONFIGURE, BTVIRT_BUILD, GUEST_HARDWARE, MISSING, PEER_NAME, WIFI, guestHardware, hardwareFiles, unitText,
} from '../src/vm/guesthw.ts'
import { PROVISION_SCRIPT, stageProvision } from '../src/vm/provision.ts'

const NONE = { acdes: null, acdesBin: null, winmanBin: null, libacde: null, dopame: null, harness: null }

describe('acdev vm provision: the simulated Wi-Fi, Bluetooth and battery', () => {
  test('all three are on unless --no-<name>; --wifi and the like change nothing', () => {
    expect(guestHardware(new Map())).toEqual({ on: ['wifi', 'bluetooth', 'battery'], off: [], btvirt: null })
    expect(guestHardware(new Map([['wifi', ''], ['battery', '']]))).toEqual({ on: ['wifi', 'bluetooth', 'battery'], off: [], btvirt: null })
    expect(guestHardware(new Map([['no-battery', ''], ['no-wifi', '']]))).toEqual({ on: ['bluetooth'], off: ['wifi', 'battery'], btvirt: null })
  })

  test('each part brings its script, its unit and its packages, each package once; the parts turned off are listed', () => {
    const { scripts, units, packages, off } = hardwareFiles(GUEST_HARDWARE)
    expect(Object.keys(scripts)).toEqual(['acdev-wifi', 'acdev-bt', 'acdev-btvirt-build', 'acdev-battery'])
    expect(Object.keys(units)).toEqual(['acdev-wifi.service', 'acdev-bt.service', 'acdev-battery.service'])
    expect(packages).toEqual(['hostapd', 'iw', 'bluez', 'bluez-utils', 'upower'])
    expect(off).toEqual([])
    expect(hardwareFiles([], ['bluetooth'])).toEqual({ scripts: {}, units: {}, packages: [], off: ['acdev-bt.service'] })
  })

  test('a unit runs at boot after its daemon, and a missing module or package is not a failure', () => {
    const wifi = unitText('wifi')
    for (const line of ['Type=oneshot', 'RemainAfterExit=yes', 'After=NetworkManager.service', 'ExecStart=/usr/local/bin/acdev-wifi up',
      'ExecStop=/usr/local/bin/acdev-wifi down', `SuccessExitStatus=${MISSING}`, 'WantedBy=multi-user.target']) {
      expect(wifi).toContain(line)
    }
    expect(unitText('bluetooth')).toContain('After=bluetooth.service')
    expect(unitText('battery')).toContain('ExecStart=/usr/local/bin/acdev-battery 100 charging')
    expect(unitText('battery')).toContain('ExecStop=/usr/local/bin/acdev-battery off')
  })

  test('the stage has all three by default, and the provision script installs, enables and starts them, and stops the ones turned off', () => {
    const plain = stageProvision(NONE)
    const some = stageProvision(NONE, { on: ['wifi'], off: ['bluetooth', 'battery'] })
    try {
      expect(readFileSync(join(plain, 'hw', 'packages'), 'utf8')).toBe('hostapd\niw\nbluez\nbluez-utils\nupower\n')
      expect(readFileSync(join(plain, 'hw', 'off'), 'utf8')).toBe('')
      expect(statSync(join(plain, 'hw', 'acdev-battery')).mode & 0o111).not.toBe(0)
      expect(readFileSync(join(some, 'hw', 'off'), 'utf8')).toBe('acdev-bt.service\nacdev-battery.service\n')
      expect(readFileSync(join(some, 'hw', 'units', 'acdev-wifi.service'), 'utf8')).toBe(unitText('wifi'))
    } finally {
      rmSync(plain, { recursive: true, force: true })
      rmSync(some, { recursive: true, force: true })
    }
    for (const line of ['done <"$here/hw/packages"', 'done <"$here/hw/off"', 'systemctl disable --now "$unit"', 'systemctl daemon-reload',
      'systemctl enable "$name"', 'systemctl restart "$name" || step "warning: $name did not start"']) {
      expect(PROVISION_SCRIPT).toContain(line)
    }
  })

  test('the Wi-Fi script makes two radios, an open and a WPA2 access point, and leaves the other radio to NetworkManager', () => {
    const { scripts } = hardwareFiles(['wifi'])
    const wifi = scripts['acdev-wifi']!
    for (const line of ['modprobe mac80211_hwsim radios=2', `open=${WIFI.open} secured=${WIFI.secured} password=${WIFI.password}`,
      'ssid=$open', 'ssid=$secured', 'wpa_passphrase=$password', 'nmcli device set "$ap" managed no', 'nmcli device set "$station" managed yes',
      'CONFIG_MAC80211_HWSIM=m']) {
      expect(wifi).toContain(line)
    }
  })

  test('the Bluetooth script starts btvirt with two controllers and makes the last one discoverable', () => {
    const bt = hardwareFiles(['bluetooth']).scripts['acdev-bt']!
    for (const line of ['modprobe hci_vhci', '"$exe" -l2', 'systemctl start bluetooth', `peer=${PEER_NAME}`, 'discov on', 'CONFIG_BT_HCIVHCI=m']) {
      expect(bt).toContain(line)
    }
  })

  test('the battery script sets test_power, and refuses a level UPower would act on', () => {
    const battery = hardwareFiles(['battery']).scripts['acdev-battery']!
    for (const line of ['>"$params/battery_capacity"', '>"$params/battery_status"', 'online ac_online on', 'online ac_online off',
      'online usb_online off', 'PercentageAction', 'CONFIG_TEST_POWER=m', 'modprobe -r test_power']) {
      expect(battery).toContain(line)
    }
  })

  test('the battery script turns both supplies off when discharging, so UPower runs on the battery, and puts them back when it goes', () => {
    const battery = hardwareFiles(['battery']).scripts['acdev-battery']!
    expect(battery).toContain('else online ac_online off; current=-1600; fi')
    expect(battery).toContain('if [ -d "$params" ]; then online ac_online on; online usb_online on; fi')
  })

  test('no Arch package has btvirt: provision takes one with --btvirt, or builds emulator/btvirt from the source of the installed bluez', () => {
    const build = hardwareFiles(['bluetooth']).scripts[BTVIRT_BUILD]!
    for (const line of ['pacman -Q bluez', 'https://www.kernel.org/pub/linux/bluetooth/bluez-$version.tar.xz', `./configure ${BLUEZ_CONFIGURE.join(' ')}`,
      'make -j"$(nproc)" emulator/btvirt', 'install -Dm755 emulator/btvirt /usr/local/bin/btvirt']) {
      expect(build).toContain(line)
    }
    expect(BLUEZ_CONFIGURE).toContain('--enable-testing')
    expect(guestHardware(new Map([['btvirt', '/tmp/btvirt']])).btvirt).toBe('/tmp/btvirt')
    const dir = mkdtempSync(join(tmpdir(), 'acdev-btvirt-'))
    writeFileSync(join(dir, 'btvirt'), 'btvirt')
    const given = stageProvision(NONE, { on: ['bluetooth'], off: [], btvirt: join(dir, 'btvirt') })
    const without = stageProvision(NONE, { on: ['battery'], off: ['bluetooth'], btvirt: join(dir, 'btvirt') })
    try {
      expect(readFileSync(join(given, 'hw', 'btvirt'), 'utf8')).toBe('btvirt')
      expect(existsSync(join(without, 'hw', 'btvirt'))).toBe(false)
    } finally {
      for (const path of [dir, given, without]) rmSync(path, { recursive: true, force: true })
    }
    expect(PROVISION_SCRIPT).toContain('install -Dm755 "$here/hw/btvirt" /usr/local/bin/btvirt')
    expect(PROVISION_SCRIPT).toContain('/usr/local/bin/acdev-btvirt-build || step "warning: no btvirt')
  })
})
