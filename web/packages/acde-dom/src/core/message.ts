import { defineHandlers, EventTarget, fire, MessageEvent } from './event'
import { DOMException } from './exception'
import { host, illegal, KEY, report, tag } from './host'

export function structuredClone<T>(value: T, options?: { transfer?: unknown[] }): T {
  void options
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    if (typeof value === 'symbol') throw new DOMException(`${String(value)} could not be cloned.`, 'DataCloneError')
    return value
  }
  try {
    return host.deserialize(host.serialize(value)) as T
  } catch (error) {
    throw new DOMException((error as Error)?.message ?? 'could not be cloned', 'DataCloneError')
  }
}

let entangle: (a: MessagePort, b: MessagePort) => void
let receive: (port: MessagePort, data: unknown) => void

export class MessagePort extends EventTarget {
  #other: MessagePort | null = null
  #started = false
  #closed = false
  #queue: unknown[] = []

  constructor(...key: unknown[]) {
    illegal(key[0])
    super()
  }

  static {
    entangle = (a, b) => {
      a.#other = b
      b.#other = a
    }
    receive = (port, data) => {
      if (port.#closed) return
      if (!port.#started) return void port.#queue.push(data)
      host.setTimer(0, () => {
        if (port.#closed) return
        try {
          fire(port, new MessageEvent('message', { data }))
        } catch (error) {
          report(error)
        }
      })
    }
  }

  postMessage(message: unknown, transfer?: unknown): void {
    void transfer
    const other = this.#other
    if (!other || this.#closed) return
    receive(other, structuredClone(message))
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    const queued = this.#queue
    this.#queue = []
    for (const data of queued) receive(this, data)
  }

  close(): void {
    this.#closed = true
    if (this.#other) this.#other.#other = null
    this.#other = null
  }

  get onmessage(): unknown {
    return this.#onmessage
  }
  set onmessage(value: unknown) {
    if (this.#onmessage) this.removeEventListener('message', this.#onmessage)
    this.#onmessage = typeof value === 'function' ? (value as (e: unknown) => void) : null
    if (this.#onmessage) {
      this.addEventListener('message', this.#onmessage)
      this.start()
    }
  }
  #onmessage: ((event: unknown) => void) | null = null
}
defineHandlers(MessagePort.prototype, ['messageerror'])
tag(MessagePort)

export class MessageChannel {
  readonly port1 = new MessagePort(KEY)
  readonly port2 = new MessagePort(KEY)

  constructor() {
    entangle(this.port1, this.port2)
  }
}
tag(MessageChannel)

export class BroadcastChannel extends EventTarget {
  #closed = false

  constructor(readonly name: string) {
    super()
  }

  postMessage(message: unknown): void {
    if (this.#closed) throw new DOMException('Channel is closed', 'InvalidStateError')
    structuredClone(message)
  }

  close(): void {
    this.#closed = true
  }
}
defineHandlers(BroadcastChannel.prototype, ['message', 'messageerror'])
tag(BroadcastChannel)
