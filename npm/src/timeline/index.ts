import type { ConsoleEntry, DevPage, RequestEntry } from '../driver/types.ts'
import * as Guest from './guest.ts'
import * as HostLog from './hostlog.ts'

export const SOURCES = ['host', 'console', 'network', 'journal', 'manager', 'compositor'] as const
export type Source = (typeof SOURCES)[number]

export interface TimelineEvent {
  readonly at: number
  readonly source: Source
  readonly from: string
  readonly kind: string
  readonly text: string
  readonly clockMoved?: true
}

export interface Window {
  readonly since: Date
  readonly until: Date | null
}

export interface Feed {
  readonly source: Source
  events(window: Window): Promise<TimelineEvent[]>
}

export interface Filter {
  readonly sources?: readonly string[]
  readonly kinds?: readonly string[]
  readonly window?: string
}

export interface Timeline {
  readonly clock: Guest.Clock | null
  readonly since: Date
  readonly until: Date | null
  readonly events: readonly TimelineEvent[]
  readonly missing: readonly string[]
}

export interface Scene {
  console(options: { readonly limit: number }): Promise<DevPage<ConsoleEntry>>
  network(options: { readonly limit: number }): Promise<DevPage<RequestEntry>>
}

export interface Gather {
  readonly scene: Scene | null
  readonly guest: Guest.Runner | null
  readonly hostLog: string | null
  readonly window: Window
  readonly feeds?: readonly Feed[]
  readonly now?: () => number
}

const ENTRIES = 5000

const kindOf = (message: string): string => /(?:^|\s)event=([\w.-]+)/.exec(message)?.[1] ?? 'log'

export function fromJournal(rows: readonly Guest.JournalRow[], offsetMs: number): TimelineEvent[] {
  const moved = Guest.jumps(rows)
  return rows.map((row) => ({
    at: row.realtimeUs / 1000 - offsetMs,
    source: 'journal',
    from: row.source,
    kind: kindOf(row.message),
    text: row.message,
    ...(moved.has(row) && { clockMoved: true as const }),
  }))
}

export function fromPages(consoled: readonly ConsoleEntry[], requests: readonly RequestEntry[], offsetMs: number): TimelineEvent[] {
  const when = (entry: { readonly time: number; readonly at?: number }) => (entry.at ?? entry.time) - offsetMs
  return [
    ...consoled.map((e): TimelineEvent => ({ at: when(e), source: 'console', from: e.web, kind: e.kind === 'console' ? e.level : e.kind, text: e.text })),
    ...requests.map((e): TimelineEvent => ({
      at: when(e),
      source: 'network',
      from: e.web,
      kind: e.kind,
      text: `${e.method} ${e.url} ${e.error ?? e.status ?? (e.done ? 'done' : 'open')}${e.ms === null ? '' : ` ${e.ms} ms`}`,
    })),
  ]
}

export function fromHost(actions: readonly HostLog.HostAction[]): TimelineEvent[] {
  return actions.map((a) => ({
    at: a.at,
    source: 'host',
    from: 'acdev',
    kind: /^\w+/.exec(a.title)?.[0] ?? 'step',
    text: `${a.title} ${a.ok ? 'ok' : 'FAIL'} ${a.ms} ms${a.text ? `: ${a.text.split('\n')[0]}` : ''}`,
  }))
}

export function select(events: readonly TimelineEvent[], window: Window, filter: Filter = {}): TimelineEvent[] {
  const { sources, kinds } = filter
  const shown = filter.window === undefined ? null : filter.window
  const number = shown && /^w(\d+)$/.exec(shown)?.[1]
  const inWindow = (e: TimelineEvent) =>
    shown === null || e.from === shown || e.from.startsWith(`${shown}#`) || (number !== undefined && number !== null && e.text.includes(`window=${number}`))
  return events
    .filter((e) => e.at >= window.since.getTime() && (window.until === null || e.at <= window.until.getTime()))
    .filter((e) => !sources?.length || sources.includes(e.source))
    .filter((e) => !kinds?.length || kinds.includes(e.kind))
    .filter(inWindow)
    .sort((a, b) => a.at - b.at)
}

async function settled<T>(name: string, missing: string[], work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    missing.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    return fallback
  }
}

export async function gather(given: Gather, filter: Filter = {}): Promise<Timeline> {
  const missing: string[] = []
  const { window } = given
  const clock = given.guest ? await settled('clock', missing, () => Guest.measure(given.guest!, given.now), null) : null
  const offset = clock?.offsetMs ?? 0
  const read = async (guest: Guest.Runner) => Guest.journalRows(await guest.run(['/bin/sh', '-c', Guest.journalCommand(window.since, window.until)]))
  const journal = given.guest ? await settled('journal', missing, () => read(given.guest!), []) : []
  const scene = given.scene
  const consoled = scene ? await settled('console', missing, async () => (await scene.console({ limit: ENTRIES })).entries, []) : []
  const requests = scene ? await settled('network', missing, async () => (await scene.network({ limit: ENTRIES })).entries, []) : []
  const fed: TimelineEvent[] = []
  for (const feed of given.feeds ?? []) fed.push(...(await settled(feed.source, missing, () => feed.events(window), [])))
  const all = [
    ...fromJournal(journal, offset),
    ...fromPages(consoled, requests, offset),
    ...fromHost(given.hostLog ? HostLog.read(given.hostLog) : []),
    ...fed,
  ]
  return { clock, since: window.since, until: window.until, events: select(all, window, filter), missing }
}

const stamp = (at: number) => new Date(at).toISOString().replace('T', ' ').replace('Z', '')

export function text(timeline: Timeline): string {
  const clock = timeline.clock
    ? `clock: the guest is ${timeline.clock.offsetMs >= 0 ? '+' : ''}${Math.round(timeline.clock.offsetMs)} ms from the host `
      + `(round trip ${timeline.clock.roundTripMs} ms); times are the host's`
    : 'clock: one machine, one clock'
  const head = [`timeline ${stamp(timeline.since.getTime())} to ${timeline.until ? stamp(timeline.until.getTime()) : 'now'}`, clock]
  const missed = timeline.missing.map((m) => `not read: ${m}`)
  const rows = timeline.events.map((e) => `${stamp(e.at)} ${e.source}:${e.from} ${e.kind}${e.clockMoved ? ' (the guest clock moved)' : ''} ${e.text}`)
  return [...head, ...missed, ...(rows.length ? rows : ['(no events)'])].join('\n')
}

export function json(timeline: Timeline): string {
  return JSON.stringify(timeline, null, 2)
}

export function list(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(',').map((s) => s.trim()).filter(Boolean)
}

export interface Session extends Scene {
  readonly guest: boolean
  readonly session: { readonly pid: number; readonly endpoint: string }
}

export function hostLog(acde: Pick<Session, 'session'>): string {
  return HostLog.file(HostLog.keyOf(acde.session))
}

export async function collect(acde: Session, window: Window, filter: Filter = {}): Promise<Timeline> {
  const guest = acde.guest ? await Guest.guestRunner() : null
  return gather({ scene: acde, guest, hostLog: hostLog(acde), window }, filter)
}

export function since(acde: Session): (from: Date) => Promise<string> {
  return async (from) => text(await collect(acde, { since: from, until: null }))
}

export function fromFlags(flags: ReadonlyMap<string, string>, parse: (given: string | undefined, now: Date) => Date): { window: Window; filter: Filter } {
  const now = new Date()
  const until = flags.get('until')
  const window = { since: parse(flags.get('since'), now), until: until === undefined ? null : parse(until, now) }
  const sources = list(flags.get('source'))
  const unknown = sources?.filter((s) => !(SOURCES as readonly string[]).includes(s)) ?? []
  if (unknown.length) throw new Error(`timeline: --source ${unknown.join(',')}: the sources are ${SOURCES.join(', ')}`)
  const kinds = list(flags.get('kind'))
  const shown = flags.get('window')
  return { window, filter: { ...(sources && { sources }), ...(kinds && { kinds }), ...(shown !== undefined && { window: shown }) } }
}
