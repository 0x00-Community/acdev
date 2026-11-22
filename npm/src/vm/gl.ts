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

export const HEADLESS_GL = '--headless --gl: 3D rendered off screen (egl-headless); acdev vm screenshot cannot read it (QEMU has no '
  + 'surface for a GL scanout): use acdev screen --session vm -o FILE.png'

const OFF = (note: string): GlChoice => ({ gl: false, note: `${note}: the guest runs without 3D (virgl)` })

export function glChoice(facts: GlFacts): GlChoice {
  if (facts.asked === false || facts.vga === 'std') return { gl: false, note: null }
  if (facts.display === 'none' && facts.asked !== true) return { gl: false, note: null }
  if (facts.platform !== 'linux') return OFF(`acdev turns 3D on only on Linux hosts so far (QEMU's GL displays on ${facts.platform} are not wired up or tried)`)
  if (facts.display === 'vnc') return OFF('--vnc has no GL display')
  if (facts.display === 'viewer') return OFF('--viewer (acdevtool view) shows no GL scanouts')
  if (facts.display === 'none' && facts.outputs > 1) return OFF(`--headless with --outputs ${facts.outputs} uses the D-Bus display, without GL`)
  if (!facts.devices().includes(facts.device)) return OFF(`this QEMU has no ${facts.device} device (qemu-system -device help)`)
  if (!facts.renderNode()) return OFF('no GPU render node here (/dev/dri/renderD*)')
  if (facts.display === 'none') return { gl: true, note: HEADLESS_GL }
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
