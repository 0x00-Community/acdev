import { setTimeout as sleep } from 'node:timers/promises'
import type { InspectNode, InspectWindow } from '@acde/api'
import type { DevPage, QueryOptions, QueryResult, RequestEntry, Snapshot, SnapshotOptions, Web } from '../types.ts'

export const TIMEOUT_MS = 30_000
export const QUIET_MS = 500
export const FIRST_STEP_MS = 100
export const LAST_STEP_MS = 500
const NOT_YET = /(?:^|: )no page \S|has no page|the page went away/

export type Condition =
  | { readonly kind: 'page'; readonly web: string }
  | { readonly kind: 'window'; readonly match?: string; readonly focused?: boolean; readonly gone?: boolean }
  | { readonly kind: 'element'; readonly text: string; readonly window?: string; readonly gone?: boolean }
  | { readonly kind: 'stable'; readonly window?: string; readonly ref?: string; readonly selector?: string; readonly quiet?: number }
  | { readonly kind: 'network-idle'; readonly web?: string; readonly quiet?: number }
  | { readonly kind: 'eval'; readonly code: string; readonly web?: string; readonly app?: string; readonly window?: string }
  | { readonly kind: 'service'; readonly name: string; readonly web?: string }

export const KINDS: readonly Condition['kind'][] = ['page', 'window', 'element', 'stable', 'network-idle', 'eval', 'service']

export interface WaitScene {
  windows(): Promise<InspectWindow[]>
  snapshot(options: SnapshotOptions): Promise<Snapshot>
  webs(): Promise<Web[]>
  query(options: QueryOptions): Promise<QueryResult>
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
  readonly value: unknown
}

export class WaitTimeout extends Error {
  override readonly name = 'WaitTimeout'
  readonly seen: string
  readonly value: unknown

  constructor(condition: Condition, ms: number, seen: string, value: unknown = null) {
    super(`wait ${describe(condition)}: not within ${ms} ms; last seen: ${seen}`)
    this.seen = seen
    this.value = value
  }
}

interface Probe {
  readonly done: boolean
  readonly seen: string
  readonly value?: unknown
}

type Prober = () => Promise<Probe>

const REAL: Pace = { now: () => Date.now(), pause: (ms) => sleep(ms) }

export function describe(condition: Condition): string {
  switch (condition.kind) {
    case 'page':
      return `page ${condition.web}`
    case 'window':
      return `window ${condition.match ?? '(any)'}${condition.focused ? ' focused' : ''}${condition.gone ? ' gone' : ''}`
    case 'element':
      return `element ${JSON.stringify(condition.text)}${condition.gone ? ' gone' : ''}${condition.window ? ` in ${condition.window}` : ''}`
    case 'stable': {
      const what = condition.ref ?? condition.selector ?? condition.window
      return `stable${what ? ` ${what}` : ''}`
    }
    case 'network-idle':
      return `network-idle${condition.web ? ` ${condition.web}` : ''}`
    case 'eval':
      return `eval ${pageName(condition)} ${JSON.stringify(condition.code)}`
    case 'service':
      return `service ${condition.name}`
  }
}

function pageName(condition: Extract<Condition, { kind: 'eval' }>): string {
  if (condition.web !== undefined) return condition.web
  return condition.app !== undefined ? `--app ${condition.app}` : `--window ${condition.window}`
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

function ordinary(window: InspectWindow): boolean {
  return window.kind !== 'desktop' && window.mode !== 'lock' && window.mode !== 'confirm'
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

async function webOf(scene: WaitScene, condition: Extract<Condition, { kind: 'eval' }>): Promise<string | null> {
  if (condition.web !== undefined) return condition.web
  const webs = await scene.webs()
  if (condition.app !== undefined) return webs.find((w) => w.app === condition.app)?.name ?? null
  const window = (await scene.windows()).find((w) => windowMatches(w, condition.window ?? ''))
  return window ? (webs.find((w) => w.window === window.id)?.name ?? null) : null
}

function evaluated(scene: WaitScene, web: () => Promise<string | null>, code: string): Prober {
  return async () => {
    const name = await web()
    if (name === null) return { done: false, seen: 'no page there yet' }
    const got = await unlessNotYet(scene.evaluate(name, code))
    if ('missing' in got) return { done: false, seen: got.missing }
    return { done: Boolean(got.value), seen: JSON.stringify(got.value ?? null), value: got.value ?? null }
  }
}

function matching(snapshot: Snapshot, text: string): string[] {
  const needle = text.trim().toLowerCase()
  const found: string[] = []
  const walk = (nodes: readonly InspectNode[]) => {
    for (const node of nodes) {
      const said = [node.name, node.value].find((s) => s?.toLowerCase().includes(needle))
      if (said !== undefined) found.push(said)
      walk(node.children ?? [])
    }
  }
  for (const nodes of Object.values(snapshot.trees)) walk(nodes)
  return found
}

function looked(nodes: readonly InspectNode[]): { text: string[]; at: string } {
  const text = nodes.map((n) => n.value ?? n.name ?? '')
  return { text, at: JSON.stringify(nodes.map((n) => [n.rect, n.name, n.value])) }
}

function element(scene: WaitScene, condition: Extract<Condition, { kind: 'stable' }>): () => Promise<{ text: string[]; at: string }> {
  const window = condition.window && { window: condition.window }
  if (condition.selector !== undefined) {
    return async () => looked((await scene.query({ selector: condition.selector!, ...window, ...(condition.ref && { ref: condition.ref }) })).nodes)
  }
  return async () => {
    const snapshot = await scene.snapshot({ ref: condition.ref!, all: true })
    return looked(Object.values(snapshot.trees).flat())
  }
}

function windowProbe(scene: WaitScene, condition: Extract<Condition, { kind: 'window' }>): Prober {
  return async () => {
    const windows = await scene.windows()
    if (condition.match === undefined) {
      const left = windows.filter(ordinary)
      return { done: left.length === 0, seen: `${left.length} windows open`, value: left.length }
    }
    const found = windows.find((w) => windowMatches(w, condition.match!))
    if (condition.gone) return { done: found === undefined, seen: found ? `${found.ref} is still there` : 'gone', value: found ?? null }
    const done = found !== undefined && (!condition.focused || found.focus)
    const seen = found ? `${found.ref}${found.focus ? ' focused' : ' not focused'}` : `${windows.length} windows, none matches`
    return { done, seen, value: found ?? null }
  }
}

function prober(scene: WaitScene, condition: Condition, pace: Pace): Prober {
  switch (condition.kind) {
    case 'page':
      return evaluated(scene, async () => condition.web, 'true')
    case 'eval':
      return evaluated(scene, () => webOf(scene, condition), condition.code)
    case 'service': {
      const code = `import('acde:services').then((m) => m.services.names().includes(${JSON.stringify(condition.name)}))`
      return evaluated(scene, async () => condition.web ?? 'desktop', code)
    }
    case 'window':
      return windowProbe(scene, condition)
    case 'element':
      return async () => {
        const snapshot = await scene.snapshot({ all: true, ...(condition.window && { window: condition.window }) })
        const texts = matching(snapshot, condition.text)
        return { done: condition.gone ? texts.length === 0 : texts.length > 0, seen: `${texts.length} matching`, value: { count: texts.length, texts } }
      }
    case 'stable': {
      const settled = quietFor(condition.quiet ?? QUIET_MS, pace)
      if (condition.ref !== undefined || condition.selector !== undefined) {
        const look = element(scene, condition)
        return async () => {
          const { text, at } = await look()
          return { ...settled(at), value: text }
        }
      }
      return async () => settled((await scene.snapshot({ all: true, ...(condition.window && { window: condition.window }) })).text)
    }
    case 'network-idle': {
      const settled = quietFor(condition.quiet ?? QUIET_MS, pace)
      return async () => {
        const entries = (await scene.network({ limit: 500, ...(condition.web && { web: condition.web }) })).entries
        const open = entries.filter((e) => !e.done).length
        const quiet = settled(entries.map((e) => `${e.seq}:${e.done}`).join(','))
        return { done: open === 0 && quiet.done, seen: `${open} open; ${quiet.seen}`, value: open }
      }
    }
  }
}

export async function waitFor(scene: WaitScene, condition: Condition, timeout = TIMEOUT_MS, pace: Pace = REAL): Promise<Waited> {
  const started = pace.now()
  const probe = prober(scene, condition, pace)
  let step = FIRST_STEP_MS
  for (;;) {
    const { done, seen, value = null } = await probe()
    const ms = pace.now() - started
    if (done) return { ms, seen, value }
    if (ms >= timeout) throw new WaitTimeout(condition, timeout, seen, value)
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
  const app = flags.get('app')
  const ref = flags.get('ref')
  const selector = flags.get('selector')
  const quiet = flags.has('quiet') ? { quiet: count('quiet', flags.get('quiet'), QUIET_MS) } : {}
  const timeout = count('timeout', flags.get('timeout'), TIMEOUT_MS)
  const windowCondition = (): Condition => {
    if (first === undefined && !flags.has('gone')) return { kind: 'window', match: need('a window (w3, an app id or a title), or --gone', first) }
    const marks = { ...(flags.has('focused') && { focused: true }), ...(flags.has('gone') && { gone: true }) }
    return { kind: 'window', ...(first !== undefined && { match: first }), ...marks }
  }
  const evalCondition = (): Condition => {
    if (app !== undefined) return { kind: 'eval', app, code: need('an expression', first) }
    if (window !== undefined) return { kind: 'eval', window, code: need('an expression', first) }
    return { kind: 'eval', web: need('a web (or --app / --window)', first), code: need('an expression', second) }
  }
  const conditions: Record<string, () => Condition> = {
    page: () => ({ kind: 'page', web: need('a web', first) }),
    window: windowCondition,
    element: () => ({ kind: 'element', text: need('a text', first), ...(window && { window }), ...(flags.has('gone') && { gone: true }) }),
    stable: () => ({ kind: 'stable', ...(window && { window }), ...(ref && { ref }), ...(selector && { selector }), ...quiet }),
    'network-idle': () => ({ kind: 'network-idle', ...(web && { web }), ...quiet }),
    eval: evalCondition,
    service: () => ({ kind: 'service', name: need('a service name', first), ...(web && { web }) }),
  }
  const make = kind === undefined ? undefined : conditions[kind]
  if (!make) throw new Error(`wait: ${kind ?? 'nothing'} is not a condition (${KINDS.join(', ')}) (acdev wait --help)`)
  return { condition: make(), timeout }
}
