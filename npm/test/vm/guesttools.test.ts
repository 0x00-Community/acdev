import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, tmp } from '../helpers.ts'
import { AGENT_UNIT, LEGACY, TOOLS_SCRIPT, devdUnit, pkginfo, pkgver, stageTools } from '../../src/vm/guesttools/index.ts'

afterAll(cleanup)

const build = { version: '0.3.0', arch: 'x86_64', builddate: 1_800_000_000 }

describe('acdev-guest-tools', () => {
  test('stages acdevd, acdev-agent, their units, the hardware scripts and units, and the sudo script, with a .PKGINFO', () => {
    const dir = tmp()
    for (const name of ['acdevd', 'acdev-agent']) writeFileSync(join(dir, name), name)
    const stage = tmp()
    stageTools(stage, { devd: join(dir, 'acdevd'), agent: join(dir, 'acdev-agent') }, build)
    const root = join(stage, 'tools', 'root')
    for (const file of ['usr/bin/acdevd', 'usr/bin/acdev-agent', 'usr/lib/acdev/acdev-wifi', 'usr/lib/acdev/acdev-btvirt-build',
      'usr/lib/acdev/acdev-dev-sudo']) {
      expect(statSync(join(root, file)).mode & 0o111).not.toBe(0)
    }
    expect(readFileSync(join(root, 'usr/lib/systemd/system/acdevd.service'), 'utf8')).toBe(devdUnit('/usr/bin/acdevd'))
    expect(readFileSync(join(root, 'usr/lib/systemd/system/acdev-agent.service'), 'utf8')).toBe(AGENT_UNIT)
    expect(existsSync(join(root, 'usr/lib/systemd/system/acdev-battery.service'))).toBe(true)
    const info = readFileSync(join(root, '.PKGINFO'), 'utf8')
    for (const line of ['pkgname = acdev-guest-tools', 'pkgver = 0.3.0-1', 'arch = x86_64', 'builddate = 1800000000']) expect(info).toContain(line)
    expect(readFileSync(join(stage, 'tools', 'version'), 'utf8')).toBe('0.3.0\n')
    const bare = tmp()
    stageTools(bare, { devd: join(dir, 'acdevd'), agent: null }, build)
    expect(existsSync(join(bare, 'tools', 'root', 'usr/bin/acdev-agent'))).toBe(false)
  })

  test('a version becomes a pkgver pacman takes, and the size is in the .PKGINFO', () => {
    expect(pkgver('0.3.0-rc.1+g1234')).toBe('0.3.0_rc.1+g1234')
    expect(pkginfo(build, 42)).toContain('size = 42\n')
  })

  test('provision packs and installs it, drops what was laid out before the package, and does not restart acdevd it runs through', () => {
    const script = TOOLS_SCRIPT.join('\n')
    for (const line of ['bsdtar -cf "$here/tools/acdev-guest-tools.pkg.tar" .PKGINFO usr', "pacman -U --noconfirm --overwrite '*'",
      'systemctl restart acdev-agent', 'pacman -Q acdev-guest-tools']) {
      expect(script).toContain(line)
    }
    expect(script).not.toContain('systemctl restart acdevd')
    expect(LEGACY).toContain('/usr/local/bin/acdevd')
    expect(LEGACY).toContain('/etc/systemd/system/acdev-wifi.service')
    expect(AGENT_UNIT).toContain('ConditionPathExists=/sys/firmware/qemu_fw_cfg/by_name/opt/acdev/key/raw')
  })
})
