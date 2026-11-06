export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
export type PageErrorKind = 'error' | 'rejection'
export type RequestKind = 'fetch' | 'xhr' | 'websocket' | 'eventsource'

export type RequestEvent =
  | { readonly phase: 'start'; readonly id: number; readonly kind: RequestKind; readonly method: string; readonly url: string; readonly bytes: number }
  | { readonly phase: 'response'; readonly id: number; readonly status: number; readonly statusText: string }
  | { readonly phase: 'end'; readonly id: number; readonly bytes: number }
  | { readonly phase: 'error'; readonly id: number; readonly message: string }

export interface Observer {
  console?(level: ConsoleLevel, text: string): void
  error?(kind: PageErrorKind, text: string): void
  request?(event: RequestEvent): void
}

export let observer: Observer | null = null

export function observe(next: Observer | null): void {
  observer = next
}

let nextRequest = 1

export class Tracked {
  readonly id = nextRequest++
  #received = 0
  #done = false

  private constructor(readonly sink: (event: RequestEvent) => void) {}

  static start(kind: RequestKind, method: string, url: string, bytes = 0): Tracked | null {
    const sink = observer?.request
    if (!sink) return null
    const tracked = new Tracked((event) => sink.call(observer, event))
    tracked.sink({ phase: 'start', id: tracked.id, kind, method, url, bytes })
    return tracked
  }

  response(status: number, statusText: string): void {
    if (!this.#done) this.sink({ phase: 'response', id: this.id, status, statusText })
  }

  received(bytes: number): void {
    this.#received += bytes
  }

  end(bytes = this.#received): void {
    if (this.#done) return
    this.#done = true
    this.sink({ phase: 'end', id: this.id, bytes })
  }

  error(message: string): void {
    if (this.#done) return
    this.#done = true
    this.sink({ phase: 'error', id: this.id, message })
  }
}
