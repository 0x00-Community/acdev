import { setTimeout as sleep } from 'node:timers/promises'
import type { InspectWindow } from '@acde/api'
import { Format } from '../format.ts'
import type { DevPage, RequestEntry, Snapshot, SnapshotOptions } from '../types.ts'

export const TIMEOUT_MS = 30_000
export const QUIET_MS = 500
export const FIRST_STEP_MS = 100
export const LAST_STEP_MS = 500
const NOT_YET = /(?:^|: )no page \S|has no page|the page went away/

export type Condition =
  | { readonly kind: 'page'; readonly web: string }
  | { readonly kind: 'window'; readonly match: string; readonly focused?: boolean }
  | { readonly kind: 'element'; readonly text: string; readonly window?: string; readonly gone?: boolean }
  | { readonly kind: 'stable'; readonly window?: string; readonly quiet?: number }
  | { readonly kind: 'network-idle'; readonly web?: string; readonly quiet?: number }
  | { readonly kind: 'eval'; readonly web: string; readonly code: string }
  | { readonly kind: 'service'; readonly name: string; readonly web?: string }

export const KINDS: readonly Condition['kind'][] = ['page', 'window', 'element', 'stable', 'network-idle', 'eval', 'service']

export interface WaitScene {
  windows(): Promise<InspectWindow[]>
  snapshot(options: SnapshotOptions): Promise<Snapshot>
  evaluate(web: string, code: string): Promise<unknown>
  network(options: { readonly web?: string; readonly limit: number }): Promise<DevPage<RequestEntry>>
}

export interface Pace {
  readonly now: () => number
  readonly pause: (ms: number) => Promise<unknown>
}

export interface Waited {
  readonly ms: number
  readonly seen: string
}

export class WaitTimeout extends Error {
  override readonly name = 'WaitTimeout'
  readonly seen: string

  constructor(condition: Condition, ms: number, seen: string) {
    super(`wait ${describe(condition)}: not within ${ms} ms; last seen: ${seen}`)
    this.seen = seen
  }
}

interface Probe {
  readonly done: boolean
  readonly seen: string
}

type Prober = () => Promise<Probe>

const REAL: Pace = { now: () => Date.now(), pause: (ms) => sleep(ms) }

export function describe(condition: Condition): string {
  switch (condition.kind) {
    case 'page':
      return `page ${condition.web}`
    case 'window':
      return `window ${condition.match}${condition.focused ? ' focused' : ''}`
    case 'element':
      return `element ${JSON.stringify(condition.text)}${condition.gone ? ' gone' : ''}${condition.window ? ` in ${condition.window}` : ''}`
    case 'stable':
      return `stable${condition.window ? ` ${condition.window}` : ''}`
    case 'network-idle':
      return `network-idle${condition.web ? ` ${condition.web}` : ''}`
    case 'eval':
      return `eval ${condition.web} ${JSON.stringify(condition.code)}`
    case 'service':
      return `service ${condition.name}`
  }
}

async function unlessNotYet<T>(work: Promise<T>): Promise<{ value: T } | { missing: string }> {
  try {
    return { value: await work }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    if (NOT_YET.test(said)) return { missing: said }
    throw error
  }
}

function windowMatches(window: InspectWindow, match: string): boolean {
  if (window.ref === match || String(window.id) === match || window.app === match) return true
  return window.title !== null && window.title.toLowerCase() === match.toLowerCase()
}

function quietFor(quiet: number, pace: Pace): (current: string) => Probe {
  let last: string | null = null
  let since = 0
  return (current) => {
    const now = pace.now()
    if (current !== last) {
      last = current
      since = now
    }
    const still = now - since
    return { done: still >= quiet, seen: `unchanged for ${still} ms of ${quiet}` }
  }
}

function evaluated(scene: WaitScene, web: string, code: string): Prober {
  return async () => {
    const got = await unlessNotYet(scene.evaluate(web, code))
    if ('missing' in got) return { done: false, seen: got.missing }
    return { done: Boolean(got.value), seen: JSON.stringify(got.value ?? null) }
  }
}

function prober(scene: WaitScene, condition: Condition, pace: Pace): Prober {
  switch (condition.kind) {
    case 'page':
      return evaluated(scene, condition.web, 'true')
    case 'eval':
      return evaluated(scene, condition.web, condition.code)
    case 'service': {
      const code = `import('acde:services').then((m) => m.services.names().includes(${JSON.stringify(condition.name)}))`
      return evaluated(scene, condition.web ?? 'desktop', code)
    }
    case 'window':
      return async () => {
        const windows = await scene.windows()
        const found = windows.find((w) => windowMatches(w, condition.match))
        const done = found !== undefined && (!condition.focused || found.focus)
        const seen = found ? `${found.ref}${found.focus ? ' focused' : ' not focused'}` : `${windows.length} windows, none matches`
        return { done, seen }
      }
    case 'element':
      return async () => {
        const snapshot = await scene.snapshot({ all: true, ...(condition.window && { window: condition.window }) })
        const hits = Format.found(snapshot, condition.text).filter((line) => line.startsWith('- ')).length
        return { done: condition.gone ? hits === 0 : hits > 0, seen: `${hits} matching` }
      }
    case 'stable': {
      const settled = quietFor(condition.quiet ?? QUIET_MS, pace)
      return async () => settled((await scene.snapshot({ all: true, ...(condition.window && { window: condition.window }) })).text)
    }
    case 'network-idle': {
      const settled = quietFor(condition.quiet ?? QUIET_MS, pace)
      return async () => {
        const entries = (await scene.network({ limit: 500, ...(condition.web && { web: condition.web }) })).entries
        const open = entries.filter((e) => !e.done).length
        const quiet = settled(entries.map((e) => `${e.seq}:${e.done}`).join(','))
        return { done: open === 0 && quiet.done, seen: `${open} open; ${quiet.seen}` }
      }
    }
  }
}

export async function waitFor(scene: WaitScene, condition: Condition, timeout = TIMEOUT_MS, pace: Pace = REAL): Promise<Waited> {
  const started = pace.now()
  const probe = prober(scene, condition, pace)
  let step = FIRST_STEP_MS
  for (;;) {
    const { done, seen } = await probe()
    const ms = pace.now() - started
    if (done) return { ms, seen }
    if (ms >= timeout) throw new WaitTimeout(condition, timeout, seen)
    await pace.pause(Math.min(step, Math.max(0, timeout - ms)))
    step = Math.min(LAST_STEP_MS, step * 2)
  }
}

export interface WaitArgs {
  readonly condition: Condition
  readonly timeout: number
}

function count(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`wait: --${flag} ${value}: a number of milliseconds`)
  return n
}

export function fromArgs(args: readonly string[], flags: ReadonlyMap<string, string>): WaitArgs {
  const [kind, first, second] = args
  const need = (what: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`wait ${kind}: needs ${what} (acdev wait --help)`)
    return value
  }
  const window = flags.get('window')
  const web = flags.get('web')
  const quiet = flags.has('quiet') ? { quiet: count('quiet', flags.get('quiet'), QUIET_MS) } : {}
  const timeout = count('timeout', flags.get('timeout'), TIMEOUT_MS)
  const conditions: Record<string, () => Condition> = {
    page: () => ({ kind: 'page', web: need('a web', first) }),
    window: () => ({ kind: 'window', match: need('a window (w3, an app id or a title)', first), ...(flags.has('focused') && { focused: true }) }),
    element: () => ({ kind: 'element', text: need('a text', first), ...(window && { window }), ...(flags.has('gone') && { gone: true }) }),
    stable: () => ({ kind: 'stable', ...(window && { window }), ...quiet }),
    'network-idle': () => ({ kind: 'network-idle', ...(web && { web }), ...quiet }),
    eval: () => ({ kind: 'eval', web: need('a web', first), code: need('an expression', second) }),
    service: () => ({ kind: 'service', name: need('a service name', first), ...(web && { web }) }),
  }
  const make = kind === undefined ? undefined : conditions[kind]
  if (!make) throw new Error(`wait: ${kind ?? 'nothing'} is not a condition (${KINDS.join(', ')}) (acdev wait --help)`)
  return { condition: make(), timeout }
}
