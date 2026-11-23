import { setTimeout as sleep } from 'node:timers/promises'
import type { DevPage, PageCursor } from './types.ts'

export interface LogLine {
  readonly seq: number
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

export interface LogSlice {
  readonly lines: readonly LogLine[]
  readonly text: string
  readonly next: number
  readonly dropped: number
}

export class Logs {
  static readonly KEEP = 5_000

  readonly #lines: LogLine[] = []
  readonly #following: Promise<void>[] = []
  #next = 1

  follow(stream: AsyncIterable<Uint8Array | string>, name: LogLine['stream']): void {
    this.#following.push((async () => {
      const decoder = new TextDecoder()
      let rest = ''
      for await (const chunk of stream) {
        const parts = (rest + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).split('\n')
        rest = parts.pop()!
        for (const text of parts) this.push(name, text)
      }
      rest += decoder.decode()
      if (rest) this.push(name, rest)
    })().catch(() => undefined))
  }

  async drained(ms: number): Promise<boolean> {
    const timer = new AbortController()
    const ended = Promise.all(this.#following).then(() => true)
    const late = sleep(ms, false, { signal: timer.signal }).catch(() => false)
    try {
      return await Promise.race([ended, late])
    } finally {
      timer.abort()
    }
  }

  push(stream: LogLine['stream'], text: string): void {
    this.#lines.push({ seq: this.#next++, stream, text: text.replace(/\r$/, '') })
    if (this.#lines.length > Logs.KEEP) this.#lines.splice(0, this.#lines.length - Logs.KEEP)
  }

  get next(): number {
    return this.#next
  }

  since(seq: number, options: { readonly grep?: RegExp; readonly limit?: number } = {}): LogSlice {
    const first = this.#lines[0]?.seq ?? this.#next
    const lines = this.#lines.filter((l) => l.seq >= seq && (!options.grep || options.grep.test(l.text)))
    return Logs.#slice(options.limit === undefined ? lines : lines.slice(-options.limit), this.#next, Math.max(0, first - seq))
  }

  tail(count: number, options: { readonly grep?: RegExp } = {}): LogSlice {
    const lines = this.#lines.filter((l) => !options.grep || options.grep.test(l.text)).slice(-Math.max(0, count))
    return Logs.#slice(lines, this.#next, 0)
  }

  static #slice(lines: readonly LogLine[], next: number, dropped: number): LogSlice {
    return { lines, text: lines.map((l) => l.text).join('\n'), next, dropped }
  }
}

interface PageAnswer<T> {
  readonly key?: string
  readonly entries?: readonly T[]
  readonly next?: number
  readonly dropped?: number
  readonly origin?: number
  readonly error?: string
}

type Ask = (args: Readonly<Record<string, unknown>>) => Promise<unknown>

async function read<T extends { readonly time: number }>(
  op: 'console' | 'network',
  options: { readonly web?: string; readonly since?: number | PageCursor; readonly limit?: number },
  ask: Ask,
  merge: boolean,
): Promise<DevPage<T>> {
  const { since, ...rest } = options
  if (!merge || options.web !== undefined) {
    if (since !== undefined && typeof since !== 'number') throw new Error(`${op}: since is a number when one page answers`)
    return one<T>(op, await ask({ ...rest, ...(since !== undefined && { since }) }))
  }
  if (typeof since === 'number') throw new Error(`${op}: several page processes answer here; since is the cursor of each (next of the last answer)`)
  const answer = (await ask({ ...rest, pages: true, ...(since && { since }) })) as { pages?: readonly PageAnswer<T>[] } | null
  if (!Array.isArray(answer?.pages)) return one<T>(op, answer)
  return merged(answer.pages, options.limit)
}

function merged<T extends { readonly time: number }>(pages: readonly PageAnswer<T>[], limit: number | undefined): DevPage<T> {
  const answered = pages.filter((p) => p.key !== undefined && Array.isArray(p.entries))
  const at = answered.flatMap((p) => p.entries!.map((entry) => [(p.origin ?? 0) + entry.time, entry] as const))
  const sorted = at.sort(([a], [b]) => a - b).map(([, entry]) => entry)
  const entries = limit === undefined ? sorted : sorted.slice(-limit)
  const cursors = Object.fromEntries(answered.map((p) => [p.key!, p.next ?? 1]))
  const failed = pages.filter((p) => p.error !== undefined).map((p) => `${p.key ?? 'a page'}: ${p.error}`)
  const dropped = answered.reduce((sum, p) => sum + (p.dropped ?? 0), 0)
  return { entries, next: 0, dropped, cursor: cursors, ...(failed.length && { failed }) }
}

function cursor(text: string): PageCursor | null {
  const pairs = text.split(',').map((part) => /^(.+)=([1-9]\d*)$/.exec(part.trim()))
  if (!pairs.length || pairs.some((m) => !m)) return null
  return Object.fromEntries(pairs.map((m) => [m![1]!, Number(m![2])]))
}

function shown(given: PageCursor): string {
  return Object.entries(given).map(([key, seq]) => `${key}=${seq}`).join(',')
}

function one<T>(op: string, answer: unknown): DevPage<T> {
  const page = answer as DevPage<T> | null
  if (!Array.isArray(page?.entries)) throw new Error(`acdev runtime answered ${op} without entries`)
  return page
}

export const PageLogs = { read, merged, cursor, shown } as const
