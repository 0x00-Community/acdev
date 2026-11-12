import { Level, Log } from './log'

type Handler = (state: unknown) => void

export interface WatchNatives {
  watch(callback: Handler): void
}

export class Watched {
  readonly #name: string
  readonly #watch: WatchNatives['watch']
  readonly #handlers = new Set<Handler>()
  #watching = false

  private constructor(name: string, watch: WatchNatives['watch']) {
    this.#name = name
    this.#watch = watch
  }

  static module(name: string, natives: WatchNatives): object {
    const { watch, ...methods } = natives as WatchNatives & Record<string, unknown>
    const watched = new Watched(name, watch)
    return { ...methods, on: (type: string, handler: unknown) => watched.on(type, handler) }
  }

  on(type: string, handler: unknown): () => boolean {
    if (type !== 'changed') throw new TypeError(`acde:${this.#name} has no ${String(type)} event`)
    if (typeof handler !== 'function') throw new TypeError(`acde:${this.#name} on: the handler is not a function`)
    const fn = handler as Handler
    this.#handlers.add(fn)
    if (!this.#watching) {
      this.#watching = true
      this.#watch((state) => {
        for (const each of [...this.#handlers]) {
          try {
            each(state)
          } catch (error) {
            Log.write(Level.Warn, 'acde_host', `acde:${this.#name} changed: ${(error as Error)?.message ?? String(error)}`)
          }
        }
      })
    }
    return () => this.#handlers.delete(fn)
  }
}
