import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

export interface GlFacts {
  readonly asked: boolean | undefined
  readonly platform: string
  readonly vga: 'virtio' | 'std'
  readonly display: string
  readonly outputs: number
  readonly device: string
  readonly devices: () => readonly string[]
  readonly renderNode: () => boolean
}

export interface GlChoice {
  readonly gl: boolean
  readonly note: string | null
}

const OFF = (note: string): GlChoice => ({ gl: false, note: `${note}: the guest runs without 3D (virgl)` })

export function glChoice(facts: GlFacts): GlChoice {
  if (facts.asked === false || facts.vga === 'std') return { gl: false, note: null }
  if (facts.platform !== 'linux') return OFF(`3D needs a Linux host (QEMU on ${facts.platform} has no GL display acdev uses)`)
  if (facts.display === 'vnc') return OFF('--vnc has no GL display')
  if (facts.display === 'viewer') return OFF('--viewer (acdevtool view) shows no GL scanouts')
  if (facts.display === 'none' && facts.outputs > 1) return OFF(`--headless with --outputs ${facts.outputs} uses the D-Bus display, without GL`)
  if (!facts.devices().includes(facts.device)) return OFF(`this QEMU has no ${facts.device} device (qemu-system -device help)`)
  if (!facts.renderNode()) return OFF('no GPU render node here (/dev/dri/renderD*)')
  return { gl: true, note: null }
}

export function qemuDevices(system: string): string[] {
  const listed = spawnSync(system, ['-device', 'help'], { encoding: 'utf8', timeout: 30_000 })
  return [...(listed.stdout ?? '').matchAll(/^name "([^"]+)"/gm)].map((found) => found[1]!)
}

export function renderNode(dir = '/dev/dri'): boolean {
  try {
    return readdirSync(dir).some((name) => name.startsWith('renderD'))
  } catch {
    return false
  }
}

export const GL_FAILED = /egl|opengl|virgl|render ?node|gbm|epoxy|gl=on/i

export function windowed(display: string): boolean {
  return display === 'sdl' || display === 'gtk' || display === 'window'
}
