import { defineHandlers, Event, EventTarget, fire } from './event'
import { DOMException } from './exception'
import { host, tag } from './host'

let signalAbort: (signal: AbortSignal, reason: unknown) => void
let makeSignal: () => AbortSignal
let constructing = false

export class AbortSignal extends EventTarget {
  #aborted = false
  #reason: unknown = undefined
  #dependents: WeakRef<AbortSignal>[] | null = null

  constructor() {
    if (!constructing) throw new TypeError('Illegal constructor')
    super()
  }

  static {
    signalAbort = (signal, reason) => {
      if (signal.#aborted) return
      signal.#aborted = true
      signal.#reason = reason === undefined ? new DOMException('signal is aborted without reason', 'AbortError') : reason
      fire(signal, new Event('abort'))
      for (const ref of signal.#dependents ?? []) {
        const dependent = ref.deref()
        if (dependent) signalAbort(dependent, signal.#reason)
      }
      signal.#dependents = null
    }
    makeSignal = () => {
      constructing = true
      try {
        return new AbortSignal()
      } finally {
        constructing = false
      }
    }
  }

  get aborted(): boolean {
    return this.#aborted
  }

  get reason(): unknown {
    return this.#reason
  }

  throwIfAborted(): void {
    if (this.#aborted) throw this.#reason
  }

  static abort(reason?: unknown): AbortSignal {
    const signal = makeSignal()
    signalAbort(signal, reason)
    return signal
  }

  static timeout(ms: number): AbortSignal {
    const signal = makeSignal()
    host.setTimer(Math.max(0, Number(ms) || 0), () => signalAbort(signal, new DOMException('signal timed out', 'TimeoutError')), false)
    return signal
  }

  static any(signals: Iterable<AbortSignal>): AbortSignal {
    const signal = makeSignal()
    for (const source of signals) {
      if (source.aborted) {
        signalAbort(signal, source.reason)
        return signal
      }
    }
    for (const source of signals) (source.#dependents ??= []).push(new WeakRef(signal))
    return signal
  }
}
defineHandlers(AbortSignal.prototype, ['abort'])
tag(AbortSignal)

export class AbortController {
  readonly #signal = makeSignal()

  get signal(): AbortSignal {
    return this.#signal
  }

  abort(reason?: unknown): void {
    signalAbort(this.#signal, reason)
  }
}
tag(AbortController)
