import { unref } from '../sys/timers'
import { WindowPlaces, type Rect } from '../places'
import type { RawShellEvent } from '../native'
import type { BrokerShell, WindowRecord } from './types'
import type { Web } from './web'

export interface WindowRecordsHost {
  shell(): BrokerShell
  webs(): Web[]
  toDesktop(event: Record<string, unknown> | RawShellEvent): void
}

export class WindowRecords extends Map<number, WindowRecord> {
  readonly #host: WindowRecordsHost
  readonly #places = new WindowPlaces()
  readonly #placed = new Map<number, string>()
  readonly #claims: { web: Web; pid: number }[] = []

  constructor(host: WindowRecordsHost) {
    super()
    this.#host = host
  }

  running(appId: string): WindowRecord | undefined {
    for (const record of this.values()) if (record.kind === 'web' && record.app?.id === appId) return record
    return undefined
  }

  claim(web: Web, pid: number): void {
    this.#claims.push({ web, pid })
  }

  unclaim(web: Web): void {
    this.#claims.splice(0, this.#claims.length, ...this.#claims.filter((c) => c.web !== web))
  }

  placed(window: number, appId: string): void {
    this.#placed.set(window, appId)
  }

  unplace(window: number, afterMs: number): void {
    unref(setTimeout(() => !this.has(window) && this.#placed.delete(window), afterMs))
  }

  place(appId: string, screen: { width: number; height: number }): Rect | null {
    return this.#places.get(appId, screen)
  }

  keepPlaces(): void {
    for (const row of this.#host.shell().windows()) {
      const app = row.window === undefined ? undefined : this.#placed.get(row.window)
      if (app && (row.mode === 'free' || row.mode === 'fixed')) this.#places.set(app, [row.x, row.y, row.width, row.height])
    }
    this.#places.flush()
  }

  shellEvent(event: RawShellEvent): void {
    if (!event.type.startsWith('window') || event.window === undefined) return
    if (event.type === 'windowgone') return this.#gone(event)
    const host = this.#host
    const record = this.get(event.window)
    if (record?.kind === 'web') return host.toDesktop(event)
    if (event.type === 'windowopen') return this.#opened(event)
    if (!record) return host.toDesktop(event)
    if (event.type === 'windowtitle') {
      record.title = event.title ?? record.title
      record.appId = event.appId ?? record.appId
    }
    if (event.type === 'windowclose') {
      this.delete(event.window)
      record.owner?.owns.delete(event.window)
      record.starter?.started.delete(event.window)
    }
    if (record.owner) return record.owner.thread.post(event)
    record.starter?.thread.post(event)
    host.toDesktop(event)
  }

  #opened(event: RawShellEvent): void {
    const window = event.window!
    const claim = this.#claims.shift() ?? null
    const opened: WindowRecord = {
      id: window,
      kind: 'native',
      appId: event.appId ?? null,
      title: event.title ?? null,
      owner: claim?.web ?? null,
      web: null,
      app: null,
      menus: [],
    }
    this.set(window, opened)
    if (claim) {
      claim.web.owns.set(window, claim.pid)
      return claim.web.thread.post(event)
    }
    const pid = this.#host.shell().windows().find((row) => (row.window ?? row.id) === window)?.pid
    const starter = pid ? this.#host.webs().find((web) => web.startedPids.has(pid)) : undefined
    if (starter) {
      opened.starter = starter
      starter.started.add(window)
      starter.thread.post(event)
    }
    this.#host.toDesktop(event)
  }

  #gone(event: RawShellEvent): void {
    const app = this.#placed.get(event.window!)
    if (!app) return
    if (!this.has(event.window!)) this.#placed.delete(event.window!)
    this.#places.set(app, [event.x ?? NaN, event.y ?? NaN, event.width ?? NaN, event.height ?? NaN])
  }
}
