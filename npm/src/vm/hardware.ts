import { join } from 'node:path'
import type { Guest } from './host.ts'

export type Audio = 'none' | 'wav'

export const AUDIOS: readonly Audio[] = ['none', 'wav']
export const XHCI = 'xhci'
export const SOUND = 'sound0'
export const AUDIODEV = 'snd0'
export const WAV = 'audio.wav'

export function audioOf(text: string | undefined): Audio {
  if (text === undefined || text === '') return 'none'
  const found = AUDIOS.find((audio) => audio === text)
  if (!found) throw new Error(`vm start: --audio ${text}: one of ${AUDIOS.join(', ')}`)
  return found
}

export function audioArgs(audio: Audio, logs: string): string[] {
  const backend = audio === 'wav' ? `wav,id=${AUDIODEV},path=${join(logs, WAV)}` : `none,id=${AUDIODEV}`
  return ['-audiodev', backend, '-device', `ich9-intel-hda,id=${SOUND}`, '-device', `hda-duplex,bus=${SOUND}.0,audiodev=${AUDIODEV}`]
}

export function usbArgs(): string[] {
  return ['-device', `qemu-xhci,id=${XHCI}`]
}

export function sleepArgs(guest: Guest): string[] {
  return guest === 'x86_64' ? ['-global', 'ICH9-LPC.disable_s3=0'] : []
}

export function hardwareArgs(guest: Guest, audio: Audio, logs: string): string[] {
  return [...audioArgs(audio, logs), ...usbArgs(), ...sleepArgs(guest)]
}

export type Vga = 'virtio' | 'std'

export const VGAS: readonly Vga[] = ['virtio', 'std']

export function vgaOf(text: string | undefined): Vga {
  if (text === undefined || text === '') return 'virtio'
  const found = VGAS.find((vga) => vga === text)
  if (!found) throw new Error(`vm start: --vga ${text}: one of ${VGAS.join(', ')}`)
  return found
}

export type Resolution = readonly [number, number]

export function resolutionOf(text: string | undefined): Resolution | null {
  if (text === undefined) return null
  const found = /^(\d+)x(\d+)$/.exec(text.trim())
  const [width, height] = found ? [Number(found[1]), Number(found[2])] : [0, 0]
  if (width < 320 || height < 200 || width > 7680 || height > 4320) {
    throw new Error(`vm start: --resolution ${text}: WIDTHxHEIGHT, like 1280x800 (320x200 to 7680x4320)`)
  }
  return [width, height]
}

export interface GpuChoice {
  readonly vga: Vga
  readonly gl: boolean
  readonly outputs: number
  readonly resolution: Resolution | null
}

export function gpuArgs(devices: { readonly gpu: string; readonly gpuGl: string; readonly gpuStd: string }, id: string, choice: GpuChoice): string[] {
  const size = (fallback: Resolution | null) => {
    const given = choice.resolution ?? fallback
    return given ? `,xres=${given[0]},yres=${given[1]}` : ''
  }
  if (choice.vga === 'std') return ['-device', `${devices.gpuStd},id=${id}${size([1280, 800])}`]
  const heads = choice.outputs > 1 ? `,max_outputs=${choice.outputs}` : ''
  return ['-device', `${choice.gl ? devices.gpuGl : devices.gpu},id=${id}${heads}${size(null)}`]
}

