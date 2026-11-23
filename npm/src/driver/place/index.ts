import type { InspectArg, InspectWindow } from '@acde/api'
import type { ActResult } from '../types.ts'

export type PlaceAction = 'move' | 'resize' | 'raise'

export interface PlaceChange {
  readonly place?: { readonly x: number; readonly y: number; readonly width?: number; readonly height?: number }
  readonly focus?: true
}

type Rect = readonly [number, number, number, number]

export const ACTIONS: ReadonlySet<string> = new Set<PlaceAction>(['move', 'resize', 'raise'])
const SETTLE_MS = 2000
const POLL_MS = 100

export function point(arg: InspectArg | undefined): { x: number; y: number } | null {
  const m = typeof arg === 'string' ? /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(arg) : null
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

export function size(arg: InspectArg | undefined): { width: number; height: number } | null {
  const m = typeof arg === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(arg) : null
  const wanted = m ? { width: Number(m[1]), height: Number(m[2]) } : null
  return wanted && wanted.width > 0 && wanted.height > 0 ? wanted : null
}

export function change(
  window: InspectWindow, action: PlaceAction, arg: InspectArg | undefined,
): PlaceChange | string {
  if (window.kind === 'desktop') {
    return action === 'raise'
      ? 'the desktop stays behind every window; it cannot be raised'
      : `the desktop cannot ${action}`
  }
  if (window.mode === 'confirm' || window.mode === 'lock') {
    const page = window.mode === 'confirm' ? 'the system confirm page' : 'the lock screen'
    return `${window.ref} is ${page}, which the session manager shows and puts away`
  }
  if (window.hidden) return `${window.ref} is minimized; act ${window.ref} restore first`
  if (action === 'raise') return { focus: true }
  if (action === 'move') {
    const to = point(arg)
    return to ? { place: to } : `move needs where to: screen x,y like "100,80", not ${JSON.stringify(arg ?? null)}`
  }
  const wanted = size(arg)
  if (!wanted) return `resize needs a size: WxH like "800x600", not ${JSON.stringify(arg ?? null)}`
  return { place: { x: window.rect[0], y: window.rect[1], ...wanted } }
}

export function rect(answer: unknown): Rect | null {
  const r = answer as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null
  const values = [r?.x, r?.y, r?.width, r?.height]
  return values.every((v) => typeof v === 'number') ? (values as unknown as Rect) : null
}

export function said(window: InspectWindow, at: Rect, wanted: PlaceChange['place']): ActResult {
  const shown = `${Math.round(at[0])},${Math.round(at[1])} ${Math.round(at[2])}x${Math.round(at[3])}`
  if (wanted?.width !== undefined && !sized(at, wanted)) {
    const size = `${wanted.width}x${wanted.height}`
    return { ok: true, text: `${window.ref} is at ${shown}; the app has not taken the size ${size} yet` }
  }
  return { ok: true, text: `${window.ref} is at ${shown}` }
}

export function sized(at: Rect, wanted: NonNullable<PlaceChange['place']>): boolean {
  if (wanted.width === undefined || wanted.height === undefined) return true
  return Math.round(at[2]) === Math.round(wanted.width) && Math.round(at[3]) === Math.round(wanted.height)
}

export async function settle(
  at: Rect, wanted: NonNullable<PlaceChange['place']>, read: () => Promise<Rect | undefined>,
): Promise<Rect> {
  let now = at
  const started = Date.now()
  while (!sized(now, wanted) && Date.now() - started < SETTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    now = (await read()) ?? now
  }
  return now
}

export function refused(window: InspectWindow, error: unknown): ActResult {
  const text = error instanceof Error ? error.message : String(error)
  const hint = /\bnormal\b/.test(text) ? `; act ${window.ref} restore first` : ''
  return { ok: false, text: `${text}${hint}` }
}

export interface PlaceHost {
  windows(): Promise<readonly InspectWindow[]>
  request(op: 'window', body: Readonly<Record<string, unknown>>): Promise<unknown>
}

export async function act(host: PlaceHost, ref: string, action: PlaceAction, arg: InspectArg | undefined): Promise<ActResult> {
  const window = (await host.windows()).find((w) => w.ref === ref)
  if (!window) return { ok: false, text: `no window ${ref}` }
  const wanted = change(window, action, arg)
  if (typeof wanted === 'string') return { ok: false, text: wanted }
  let answer: unknown
  try {
    answer = await host.request('window', { window: window.id, change: wanted })
  } catch (error) {
    return refused(window, error)
  }
  if (!wanted.place) return { ok: true, text: `${ref} is in front` }
  const read = async () => (await host.windows()).find((w) => w.id === window.id)?.rect
  return said(window, await settle(rect(answer) ?? window.rect, wanted.place, read), wanted.place)
}
