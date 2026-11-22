import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEADLESS_GL, glChoice, qemuDevices, renderNode, type GlFacts } from '../src/vm/gl.ts'
import { Machine } from '../src/vm/machine.ts'
import { tmp } from './helpers.ts'

const LINUX: GlFacts = {
  asked: undefined, platform: 'linux', vga: 'virtio', display: 'sdl', outputs: 1, device: 'virtio-vga-gl',
  devices: () => ['virtio-vga', 'virtio-vga-gl'], renderNode: () => true,
}

describe('acdev vm start: 3D (virgl) by default', () => {
  test('is on in a window when nothing stands against it; off without a note for --no-gl, --vga std and --headless without --gl', () => {
    expect(glChoice(LINUX)).toEqual({ gl: true, note: null })
    expect(glChoice({ ...LINUX, display: 'none' })).toEqual({ gl: false, note: null })
    expect(glChoice({ ...LINUX, asked: true, display: 'none' })).toEqual({ gl: true, note: HEADLESS_GL })
    expect(HEADLESS_GL).toContain('acdev screen --session vm')
    expect(glChoice({ ...LINUX, asked: false })).toEqual({ gl: false, note: null })
    expect(glChoice({ ...LINUX, vga: 'std', asked: true })).toEqual({ gl: false, note: null })
  })

  test('falls back with a note where the host or the display cannot have it', () => {
    const off = (facts: Partial<GlFacts>, said: string) => {
      const choice = glChoice({ ...LINUX, ...facts })
      expect(choice.gl).toBe(false)
      expect(choice.note).toContain(said)
      expect(choice.note).toContain('the guest runs without 3D')
    }
    off({ platform: 'darwin' }, 'only on Linux hosts so far')
    off({ platform: 'win32' }, 'only on Linux hosts so far')
    off({ display: 'vnc' }, '--vnc')
    off({ display: 'viewer' }, '--viewer')
    off({ display: 'none', outputs: 2, asked: true }, '--headless with --outputs 2')
    off({ devices: () => ['virtio-vga'] }, 'no virtio-vga-gl device')
    off({ renderNode: () => false }, 'no GPU render node')
    const untouched = () => { throw new Error('QEMU is not asked when the display already rules 3D out') }
    expect(glChoice({ ...LINUX, display: 'viewer', devices: untouched, renderNode: untouched }).gl).toBe(false)
  })

  test('the QEMU arguments: a GL window, egl-headless without one, the plain GPU without GL', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, { platform: 'linux', arch: 'x64' })
    expect(machine.args({ display: 'sdl', gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0 -display sdl,gl=on')
    expect(machine.args({ display: 'none', gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0 -display egl-headless')
    expect(machine.args({ display: 'none', gl: false }, 'kvm').join(' ')).toContain('-device virtio-vga,id=gpu0 -display none')
    expect(machine.args({ display: 'none', outputs: 2, gl: false }, 'kvm').join(' ')).toContain('-display dbus,p2p=yes')
  })

  test('the devices QEMU lists and the render nodes', () => {
    const fake = join(tmp(), 'qemu')
    const listing = ['name "virtio-vga", bus PCI', 'name "virtio-vga-gl", bus PCI', 'name "virtio-gpu-gl-pci", bus PCI, alias "x"']
    writeFileSync(fake, `#!/bin/sh\ncat <<'EOF'\n${listing.join('\n')}\nEOF\n`, { mode: 0o755 })
    expect(qemuDevices(fake)).toEqual(['virtio-vga', 'virtio-vga-gl', 'virtio-gpu-gl-pci'])
    const dri = tmp()
    expect(renderNode(dri)).toBe(false)
    mkdirSync(join(dri, 'renderD128'))
    expect(renderNode(dri)).toBe(true)
    expect(renderNode(join(dri, 'none'))).toBe(false)
  })
})
