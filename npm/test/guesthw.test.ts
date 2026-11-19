import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GUEST_HARDWARE, PEER_NAME, WIFI, guestHardware, hardwareFiles } from '../src/vm/guesthw.ts'
import { PROVISION_SCRIPT, stageProvision } from '../src/vm/provision.ts'

const NONE = { acdes: null, acdesBin: null, winmanBin: null, libacde: null, dopame: null, harness: null }

describe('acdev vm provision --wifi / --bluetooth / --battery', () => {
  test('only the switches given are staged, in a fixed order', () => {
    expect(guestHardware(new Map([['battery', ''], ['wifi', '']]))).toEqual(['wifi', 'battery'])
    expect(guestHardware(new Map([['user', 'qa']]))).toEqual([])
  })

  test('each part brings its script and its packages, each package once', () => {
    const { scripts, packages } = hardwareFiles(GUEST_HARDWARE)
    expect(Object.keys(scripts)).toEqual(['acdev-wifi', 'acdev-bt', 'acdev-battery'])
    expect(packages).toEqual(['hostapd', 'iw', 'bluez', 'bluez-utils', 'upower'])
    expect(hardwareFiles([])).toEqual({ scripts: {}, packages: [] })
  })

  test('the stage has hw/ only when asked, and the provision script installs what is there', () => {
    const plain = stageProvision(NONE)
    const asked = stageProvision(NONE, ['wifi'])
    try {
      expect(existsSync(join(plain, 'hw'))).toBe(false)
      expect(readFileSync(join(asked, 'hw', 'packages'), 'utf8')).toBe('hostapd\niw\n')
      expect(statSync(join(asked, 'hw', 'acdev-wifi')).mode & 0o111).not.toBe(0)
    } finally {
      rmSync(plain, { recursive: true, force: true })
      rmSync(asked, { recursive: true, force: true })
    }
    expect(PROVISION_SCRIPT).toContain('done <"$here/hw/packages"')
    expect(PROVISION_SCRIPT).toContain('install -Dm755 "$script" "/usr/local/bin/$(basename "$script")"')
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
    for (const line of ['>"$params/battery_capacity"', '>"$params/battery_status"', '>"$params/ac_online"', 'PercentageAction',
      'CONFIG_TEST_POWER=m', 'modprobe -r test_power']) {
      expect(battery).toContain(line)
    }
  })
})
