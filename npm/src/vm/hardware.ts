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
