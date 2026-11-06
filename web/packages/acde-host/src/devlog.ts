import type { ConsoleLevel, PageErrorKind, RequestEvent, RequestKind } from '@dopame/acde-dom'

export type DevPost =
  | { readonly devlog: 'console'; readonly time: number; readonly level: ConsoleLevel; readonly text: string }
  | { readonly devlog: 'error'; readonly time: number; readonly kind: PageErrorKind; readonly text: string }
  | { readonly devlog: 'request'; readonly time: number; readonly event: RequestEvent }

export interface ConsoleEntry {
  readonly seq: number
  readonly time: number
  readonly web: string
  readonly app: string | null
  readonly kind: 'console' | PageErrorKind
  readonly level: ConsoleLevel
  readonly text: string
}

export interface RequestEntry {
  readonly seq: number
  readonly time: number
  readonly web: string
  readonly app: string | null
  readonly id: number
  readonly kind: RequestKind
  readonly method: string
  readonly url: string
  readonly requestBytes: number
  status: number | null
  statusText: string | null
  responseBytes: number | null
  ms: number | null
  error: string | null
  done: boolean
}

export interface DevQuery {
  readonly web?: string
  readonly since?: number
  readonly limit?: number
}

export interface DevPage<T> {
  readonly entries: readonly T[]
  readonly next: number
  readonly dropped: number
}

interface Source {
  readonly name: string
  readonly app: string | null
}

export class DevLog {
  static readonly KEEP = 5000
  static readonly TEXT_MAX = 16_384
  static readonly LIMIT = 500

  readonly #console: ConsoleEntry[] = []
  readonly #requests: RequestEntry[] = []
  readonly #open = new Map<string, RequestEntry>()
  #nextConsole = 1
  #nextRequest = 1

  static isPost(message: unknown): message is DevPost {
    return typeof message === 'object' && message !== null && typeof (message as { devlog?: unknown }).devlog === 'string'
  }

  static text(text: string): string {
    return text.length > DevLog.TEXT_MAX ? `${text.slice(0, DevLog.TEXT_MAX)}… (${text.length - DevLog.TEXT_MAX} more characters)` : text
  }

  take(source: Source, post: DevPost): void {
    switch (post.devlog) {
      case 'console':
        return this.#log({ seq: this.#nextConsole++, time: post.time, web: source.name, app: source.app, kind: 'console', level: post.level, text: DevLog.text(post.text) })
      case 'error':
        return this.#log({ seq: this.#nextConsole++, time: post.time, web: source.name, app: source.app, kind: post.kind, level: 'error', text: DevLog.text(post.text) })
      case 'request':
        return this.#request(source, post.time, post.event)
    }
  }

  gone(web: string): void {
    for (const [key, entry] of this.#open) {
      if (entry.web !== web) continue
      entry.error ??= 'the page went away'
      entry.done = true
      this.#open.delete(key)
    }
  }

  console(query: DevQuery & { readonly level?: ConsoleLevel | 'errors' }): DevPage<ConsoleEntry> {
    const level = query.level
    return this.#page(this.#console, this.#nextConsole, query, (e) => level === undefined || (level === 'errors' ? e.level === 'error' : e.level === level))
  }

  requests(query: DevQuery & { readonly failed?: boolean }): DevPage<RequestEntry> {
    return this.#page(this.#requests, this.#nextRequest, query, (e) => !query.failed || e.error !== null || (e.status !== null && e.status >= 400))
  }

  #log(entry: ConsoleEntry): void {
    this.#console.push(entry)
    if (this.#console.length > DevLog.KEEP) this.#console.splice(0, this.#console.length - DevLog.KEEP)
  }

  #request(source: Source, time: number, event: RequestEvent): void {
    const key = `${source.name}#${event.id}`
    if (event.phase === 'start') {
      const entry: RequestEntry = {
        seq: this.#nextRequest++,
        time,
        web: source.name,
        app: source.app,
        id: event.id,
        kind: event.kind,
        method: event.method,
        url: DevLog.text(event.url),
        requestBytes: event.bytes,
        status: null,
        statusText: null,
        responseBytes: null,
        ms: null,
        error: null,
        done: false,
      }
      this.#requests.push(entry)
      this.#open.set(key, entry)
      if (this.#requests.length > DevLog.KEEP) {
        for (const old of this.#requests.splice(0, this.#requests.length - DevLog.KEEP)) this.#open.delete(`${old.web}#${old.id}`)
      }
      return
    }
    const entry = this.#open.get(key)
    if (!entry) return
    switch (event.phase) {
      case 'response':
        entry.status = event.status
        entry.statusText = event.statusText
        return
      case 'end':
        entry.responseBytes = event.bytes
        break
      case 'error':
        entry.error = DevLog.text(event.message)
        break
    }
    entry.ms = Math.round((time - entry.time) * 1000) / 1000
    entry.done = true
    this.#open.delete(key)
  }

  #page<T extends { readonly seq: number; readonly web: string; readonly app: string | null }>(all: readonly T[], next: number, query: DevQuery, keep: (entry: T) => boolean): DevPage<T> {
    const since = query.since ?? 0
    const limit = Math.max(1, Math.min(query.limit ?? DevLog.LIMIT, DevLog.KEEP))
    const web = query.web
    const matching = all.filter((e) => e.seq >= since && (web === undefined || e.web === web || e.app === web || (web === 'desktop' && e.app === null)) && keep(e))
    const first = all[0]?.seq ?? next
    return { entries: matching.slice(-limit), next, dropped: since > 0 && since < first ? first - since : 0 }
  }
}
