import * as host from 'jsrt:host'
import type { HostNative } from '@dopame/acde-dom'
import boot from './isolate'
import { DESK, DOM, SURFACE } from './kernel/natives.gen'
import { Reader, Writer } from './kernel/wire'

const enum Iface {
  Dom = 1,
  Host = 2,
  Surface = 3,
  Own = 4,
  Desk = 5,
  Natives = 6,
  System = 7,
}

const enum Out {
  Batch = 1,
  Async = 2,
  Service = 3,
  Answer = 4,
}

const enum In {
  Resolve = 1,
  Reject = 2,
  Message = 3,
  Ask = 4,
  Service = 5,
  Event = 6,
}

const BATCH_LIMIT = 64 * 1024
const post = globalThis.postMessage

let batch = new Writer()
let batched = 0
let nextRequest = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
const listeners = new Map<number, (value: unknown) => void>()
let nextListener = 0
const handlers: { message?: (message: never) => void; ask?: (kind: never, payload: unknown) => unknown; service?: (message: unknown) => void } = {}

function failure(value: unknown): Error {
  const fail = (value ?? {}) as { message?: string; status?: number | null; code?: string }
  const message = String(fail.message ?? 'failed')
  const error: Error & { status?: number; code?: string } = message.startsWith('TypeError: ')
    ? new TypeError(message.slice(11))
    : message.startsWith('RangeError: ')
      ? new RangeError(message.slice(12))
      : new Error(message)
  if (fail.status != null) error.status = fail.status
  if (fail.code) error.code = fail.code
  return error
}

function encodeCall(w: Writer, iface: Iface, name: string, args: readonly unknown[]): void {
  w.u8(iface)
  w.string(name)
  let n = args.length
  while (n > 0 && args[n - 1] === undefined) n--
  w.u32(n)
  for (let i = 0; i < n; i++) w.value(args[i])
}

function flush(): void {
  if (!batched) return
  const head = new Writer()
  head.u8(Out.Batch)
  head.u32(batched)
  head.raw(batch.take())
  post(head.take())
  batch = new Writer()
  batched = 0
}

function write(iface: Iface, name: string, args: readonly unknown[]): void {
  encodeCall(batch, iface, name, args)
  batched++
  if (batch.length > BATCH_LIMIT) flush()
}

function call(iface: Iface, name: string, args: readonly unknown[]): unknown {
  flush()
  const w = new Writer()
  encodeCall(w, iface, name, args)
  const reply = new Reader(new Uint8Array(host.call(w.take())))
  const status = reply.u8()
  const value = reply.value()
  if (status) throw failure(value)
  return value
}

function request(iface: Iface, name: string, args: readonly unknown[]): Promise<unknown> {
  flush()
  const w = new Writer()
  const id = ++nextRequest
  w.u8(Out.Async)
  w.u32(id)
  encodeCall(w, iface, name, args)
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  post(w.take())
  return promise
}

function proxy<T extends object>(iface: Iface, kinds: Readonly<Record<string, 'r' | 'w' | 'a'>>, own: object = {}): T {
  const target: Record<string, unknown> = { ...own }
  for (const [name, kind] of Object.entries(kinds)) {
    if (name in target) continue
    target[name] =
      kind === 'w' ? (...args: unknown[]) => write(iface, name, args) : kind === 'a' ? (...args: unknown[]) => request(iface, name, args) : (...args: unknown[]) => call(iface, name, args)
  }
  return target as T
}

function answer(token: number, value: unknown): void {
  const w = new Writer()
  w.u8(Out.Answer)
  w.u32(token)
  w.value(JSON.parse(JSON.stringify(value ?? null)))
  post(w.take())
}

function receive(event: { data: unknown }): void {
  if (typeof event.data === 'string') return
  const r = new Reader(new Uint8Array(event.data as ArrayBuffer))
  switch (r.u8()) {
    case In.Resolve: {
      const id = r.u32()
      const value = r.value()
      pending.get(id)?.resolve(value)
      pending.delete(id)
      return
    }
    case In.Reject: {
      const id = r.u32()
      const value = r.value()
      pending.get(id)?.reject(failure(value))
      pending.delete(id)
      return
    }
    case In.Message:
      handlers.message?.(r.value() as never)
      return
    case In.Ask: {
      const token = r.u32()
      const kind = r.string()
      const payload = r.value()
      const ask = handlers.ask
      if (!ask) return answer(token, null)
      Promise.resolve()
        .then(() => ask(kind as never, payload))
        .then(
          (value) => answer(token, value),
          () => answer(token, null),
        )
      return
    }
    case In.Service:
      handlers.service?.(host.deserialize(r.rest()))
      return
    case In.Event: {
      const token = r.u32()
      listeners.get(token)?.(r.value())
      return
    }
  }
}

function keepReceiving(): void {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'onmessage')
  if (own?.get === receiving) return
  const page = own?.set
  Object.defineProperty(globalThis, 'onmessage', {
    get: receiving,
    set(value: unknown) {
      page?.call(globalThis, value)
    },
    enumerable: true,
    configurable: true,
  })
}

function receiving(): typeof receive {
  return receive
}

keepReceiving()

const engineSetTimeout = globalThis.setTimeout
const engineClearTimeout = globalThis.clearTimeout
const engineQueueMicrotask = globalThis.queueMicrotask

const UTF8 = new Set(['', 'utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8'])
const enabled = new Map<string, boolean>()
let taskEnd: (() => void) | null = null
host.onTaskEnd(() => {
  taskEnd?.()
  keepReceiving()
  flush()
})

const hostNative: HostNative & { onTaskEnd(fn: () => void): void; setReporter(fn: (error: unknown, promise?: Promise<unknown>) => void): void; requestFrame(): void } = {
  now: host.now,
  timeOrigin: host.timeOrigin,
  setTimer: (ms, callback) => engineSetTimeout(callback, ms) as unknown as number,
  clearTimer: (handle) => engineClearTimeout(handle),
  refTimer: () => {},
  queueMicrotask: (callback) => engineQueueMicrotask(callback),
  requestFrame: () => {},
  reportError: (error) => {
    write(Iface.Host, 'print', [2, String((error as Error)?.stack ?? error)])
    flush()
  },
  print: (level, text) => write(Iface.Host, 'print', [level, text]),
  log: (level, target, text) => write(Iface.Host, 'log', [level, target, text]),
  logEnabled: (level, target) => {
    const key = `${level} ${target}`
    let on = enabled.get(key)
    if (on === undefined) {
      on = call(Iface.Host, 'logEnabled', [level, target]) as boolean
      enabled.set(key, on)
    }
    return on
  },
  clock: host.now,
  importModule: host.importModule,
  defineModule: host.defineModule,
  runModule: host.runModule,
  runScript: host.runScript,
  readAsset: (url) => call(Iface.Host, 'readAsset', [url]) as Uint8Array | null,
  addImportMap: (imports, scopes) => write(Iface.Host, 'addImportMap', [imports, scopes]),
  encodeUtf8: host.encodeUtf8,
  decode: (bytes, label, fatal, ignoreBom) => (UTF8.has(label.trim().toLowerCase()) ? host.decodeUtf8(bytes, fatal, ignoreBom) : (call(Iface.Host, 'decode', [bytes, label, fatal, ignoreBom]) as string)),
  parseUrl: (input, base) => call(Iface.Host, 'parseUrl', [input, base]) as ReturnType<HostNative['parseUrl']>,
  serialize: (value) => new Uint8Array(host.serialize(value)),
  deserialize: (bytes) => host.deserialize(bytes),
  randomBytes: (buffer) => void host.randomBytes(buffer),
  randomUUID: host.randomUUID,
  onTaskEnd: (fn) => {
    taskEnd = fn
  },
  setReporter: (fn) => host.setReporter(fn),
}

const info = call(Iface.Natives, 'init', []) as {
  init: never
  env: Record<string, string>
  place: 'desktop' | 'window'
  window: number
  storage: boolean
  grants: { fs: boolean; terminal: boolean; network: boolean; office: boolean }
}

function listen(callback: (value: unknown) => void): number {
  const token = ++nextListener
  listeners.set(token, callback)
  return token
}

function system(module: string, kinds: Readonly<Record<string, 'r' | 'a'>>, own: object = {}): object {
  const target: Record<string, unknown> = { ...own }
  for (const [name, kind] of Object.entries(kinds)) {
    if (name in target) continue
    target[name] = kind === 'a' ? (...args: unknown[]) => request(Iface.System, `${module}.${name}`, args) : (...args: unknown[]) => call(Iface.System, `${module}.${name}`, args)
  }
  return target
}

const FS = ['state', 'roots', 'desktop', 'list', 'preview', 'download', 'locate', 'openPath', 'place', 'mkdir', 'write', 'copyIn', 'rename', 'delete']
const fs = info.grants.fs ? system('fs', Object.fromEntries(FS.map((name) => [name, 'a' as const]))) : undefined
const terminal = info.grants.terminal
  ? system(
      'terminal',
      { open: 'a', input: 'a', resize: 'a', close: 'a' },
      { subscribe: (id: string, callback: (events: unknown) => void) => request(Iface.System, 'terminal.subscribe', [id, listen(callback)]) },
    )
  : undefined
const network = info.grants.network
  ? system(
      'network',
      { state: 'a', networks: 'a', connect: 'a', activate: 'a', disconnect: 'a', setWifiEnabled: 'a' },
      {
        watch: (callback: (state: unknown) => void) => {
          if (typeof callback !== 'function') throw new TypeError('acde.network.watch: the callback is not a function')
          call(Iface.System, 'network.watch', [listen(callback)])
        },
      },
    )
  : undefined
const office = info.grants.office ? (system('office', { server: 'a', state: 'a', status: 'a', save: 'a', new: 'a', writePage: 'r' }) as { writePage(key: string, html: string): string }) : undefined

const own = {
  exit(code: number): never {
    flush()
    return host.exit(code)
  },
  storage: info.storage
    ? {
        read: () => call(Iface.Own, 'storageRead', []) as string | null,
        write: (text: string) => void call(Iface.Own, 'storageWrite', [text]),
        aside: () => call(Iface.Own, 'storageAside', []) as string,
      }
    : undefined,
  files: {
    open: (options: unknown) => request(Iface.Own, 'filesOpen', [options]) as Promise<string[]>,
    save: (options: unknown) => request(Iface.Own, 'filesSave', [options]) as Promise<string[]>,
    read: (path: string, limit?: number) => call(Iface.Own, 'filesRead', [path, limit]) as { bytes: Uint8Array; lastModified: number } | null,
    write: (path: string, bytes: Uint8Array) => void call(Iface.Own, 'filesWrite', [path, bytes]),
  },
}

const desk = proxy(Iface.Desk, DESK, {
  place: info.place,
  window: info.window,
  onMessage: (fn: never) => {
    handlers.message = fn
  },
  onAsk: (fn: never) => {
    handlers.ask = fn
  },
})

const services = {
  post(message: unknown): void {
    flush()
    const bytes = new Uint8Array(host.serialize(message))
    const w = new Writer()
    w.u8(Out.Service)
    w.raw(bytes)
    post(w.take())
  },
  onMessage(fn: (message: unknown) => void): void {
    handlers.service = fn
  },
}

const natives = {
  host: hostNative,
  desk,
  services,
  init: info.init,
  env: info.env,
  own,
  fs,
  terminal,
  network,
  office,
  createDocument(width: number, height: number, scale: number, options: object) {
    call(Iface.Natives, 'createDocument', [width, height, scale, options])
    return proxy(Iface.Dom, DOM)
  },
  claimSurface() {
    const window = call(Iface.Natives, 'claimSurface', []) as number
    return proxy(Iface.Surface, SURFACE, { window })
  },
}

boot(natives as never).catch((error: unknown) => {
  write(Iface.Host, 'print', [2, `kernel boot: ${String((error as Error)?.stack ?? error)}`])
  flush()
  host.exit(1)
})
