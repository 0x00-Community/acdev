import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Machine } from '../../src/vm/machine.ts'
import { emptyDisk, FIX_BOOT, InstallerChanged, installPlan, installStatus, isoIsNewer, stamp } from '../../src/vm/image/install.ts'

describe('acdev vm fetch from the ISO', () => {
  test('the ISO wins only when its time stamp is newer than the published image', () => {
    expect(stamp('dopameos-20261122T062717Z-x86_64.iso')).toBe('20261122T062717Z')
    expect(isoIsNewer('dopameos-20261122T062717Z-x86_64.iso', 'dopameos-20261114T054429Z-x86_64.qcow2')).toBe(true)
    expect(isoIsNewer('dopameos-20261114T054429Z-x86_64.iso', 'dopameos-20261114T054429Z-x86_64.qcow2')).toBe(false)
    expect(isoIsNewer('dopameos-20261122T062717Z-x86_64.iso', '')).toBe(true)
    expect(isoIsNewer('dopameos-x86_64.iso', 'dopameos-20261114T054429Z-x86_64.qcow2')).toBe(false)
  })

  test('the empty disk is the one disk that is free and has no partitions', () => {
    const probe = JSON.stringify({ disks: [
      { path: '/dev/sr0', busy: true, partitions: [] },
      { path: '/dev/vda', busy: false, partitions: [] },
      { path: '/dev/vdb', busy: false, partitions: [{ path: '/dev/vdb1' }] },
    ] })
    expect(emptyDisk(probe)).toBe('/dev/vda')
    expect(() => emptyDisk(JSON.stringify({ disks: [] }))).toThrow('not one empty disk')
  })

  test('an answer of another shape is the installer changing, not the installation failing', () => {
    expect(() => emptyDisk('not json')).toThrow(InstallerChanged)
    expect(() => emptyDisk(JSON.stringify({ drives: [] }))).toThrow(InstallerChanged)
    expect(() => emptyDisk(JSON.stringify({ disks: [{ name: '/dev/vda' }] }))).toThrow(InstallerChanged)
    expect(() => installStatus(JSON.stringify({ phase: 'done' }))).toThrow(InstallerChanged)
  })

  test('the status gives the step, out of how many, and its name when there is one', () => {
    expect(installStatus('')).toBe(null)
    expect(installStatus('{"state": "running"')).toBe(null)
    expect(installStatus(JSON.stringify({ state: 'running', step: 1, steps: ['partition', 'copy', 'boot'] })))
      .toEqual({ state: 'running', step: 2, steps: 3, name: 'copy' })
    expect(installStatus(JSON.stringify({ state: 'done', step: 2, steps: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })))
      .toEqual({ state: 'done', step: 3, steps: 3, name: 'c' })
  })

  test('the plan installs the whole disk, portable, with the password only in the plan', () => {
    const plan = JSON.parse(installPlan('/dev/vda', 'secret')) as Record<string, unknown>
    expect(plan['where']).toEqual({ mode: 'disk', disk: '/dev/vda' })
    expect(plan['portable']).toBe(true)
    expect(plan['password']).toBe('secret')
    expect(FIX_BOOT('/dev/vda')).toContain("lsblk -lnpo NAME,PARTTYPE /dev/vda")
  })
})

describe('socket paths stay under the AF_UNIX limit', () => {
  const long = '/home/Akira/.local/share/acdev/vm/images/.install-dopameos-20261122T062717Z-x86_64.from-iso.qcow2'

  test('a deep VM directory puts its sockets in a short directory of their own', () => {
    const machine = new Machine({ ACDEV_VM_DIR: long, XDG_RUNTIME_DIR: '/run/user/1000' }, { platform: 'linux', arch: 'x64' })
    expect(join(long, 'run', 'qmp.sock').length).toBeGreaterThan(Machine.SOCKET_PATH_MOST)
    for (const path of [machine.qmp, machine.qga, join(machine.sockets, 'devd.sock')]) {
      expect(path.length).toBeLessThanOrEqual(Machine.SOCKET_PATH_MOST)
      expect(path.startsWith('/run/user/1000/acdev-')).toBe(true)
    }
  })

  test('a short VM directory keeps them in run/', () => {
    const machine = new Machine({ ACDEV_VM_DIR: '/tmp/vm' }, { platform: 'linux', arch: 'x64' })
    expect(machine.qmp).toBe('/tmp/vm/run/qmp.sock')
  })
})
