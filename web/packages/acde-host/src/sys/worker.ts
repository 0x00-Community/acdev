import { sys, type WebThreadHandle } from './natives'

export class WebThread {
  readonly #handle: WebThreadHandle
  readonly #listeners: ((message: unknown) => void)[] = []
  readonly #exited: Promise<number>

  constructor(options: { name: string; init: unknown; env: Record<string, string>; heapMb: number; fs: true | string[] | null; onExit: (code: number, reason: string | null) => void }) {
    let exit!: (code: number) => void
    this.#exited = new Promise((resolve) => (exit = resolve))
    this.#handle = sys().spawnWeb(options.name, options.init, options.heapMb, options.env,
      (message) => {
        for (const listener of this.#listeners) listener(message)
      },
      (code, reason) => {
        options.onExit(code, reason)
        exit(code)
      },
      options.fs)
  }

  on(_event: 'message', listener: (message: unknown) => void): void {
    this.#listeners.push(listener)
  }

  postMessage(message: unknown): void {
    this.#handle.post(message)
  }

  busyMs(): number {
    return this.#handle.busyMs()
  }

  cpuMs(): number {
    return this.#handle.cpuMs()
  }

  terminate(): Promise<number> {
    this.#handle.terminate()
    return this.#exited
  }
}
