import { setTimeout as sleep } from 'node:timers/promises'

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
