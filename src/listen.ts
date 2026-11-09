import type { Socket as UdpSocket } from 'node:dgram'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server as NetServer } from 'node:net'
import { CHANNEL_MARK, channelMode, controlMode, serveChannel, serveControl, unserveChannel } from './channel.ts'
import { socketPath } from './sockets.ts'

const dgram = process.getBuiltinModule('node:dgram')
const { chmodSync, lstatSync, mkdirSync, unlinkSync } = process.getBuiltinModule('node:fs')
const http = process.getBuiltinModule('node:http')
const https = process.getBuiltinModule('node:https')
const net = process.getBuiltinModule('node:net')
const { dirname } = process.getBuiltinModule('node:path')
const { Readable } = process.getBuiltinModule('node:stream')
const tls = process.getBuiltinModule('node:tls')

type Fn = (...args: unknown[]) => unknown
type Options = Record<PropertyKey, unknown>

const INSTALLED = Symbol.for('acde.listen')
const SERVE = Symbol.for('acde.serve')
const live = new Set<string>()

function toPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const port = typeof value === 'string' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`acde: bad port ${String(value)}`)
  }
  return port
}

function envPort(): number {
  const env = process.env
  return toPort(env['BUN_PORT']) ?? toPort(env['PORT']) ?? toPort(env['NODE_PORT']) ?? 3000
}

function refuse(what: string): never {
  throw Object.assign(new Error(`acde: ${what}: an acde app listens on unix sockets only`), { code: 'EACCES' })
}

function prepare(port: number): string {
  const path = socketPath(port)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  if (!live.has(path)) {
    try {
      if (lstatSync(path).isSocket()) unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return path
}

function controlled(stop: () => unknown): () => void {
  return controlMode(process.env, typeof Bun !== 'undefined') ? serveControl(stop) : () => undefined
}

function onSocket(options: object, path: string): Options {
  const mapped: Options = Object.create(options)
  for (const key of ['port', 'hostname', 'host', 'reusePort', 'ipv6Only']) mapped[key] = undefined
  mapped['unix'] = path
  return mapped
}

function looksBound<T extends object>(server: T, port: number, hostname?: string): T {
  const host = hostname && hostname !== '0.0.0.0' && hostname !== '::' ? hostname : 'localhost'
  const shown = host.includes(':') ? `[${host}]` : host
  Object.defineProperties(server, {
    port: { configurable: true, value: port },
    hostname: { configurable: true, value: host },
    url: { configurable: true, value: new URL(`http://${shown}:${port}/`) },
  })
  return server
}

function onUnix(original: Fn, fallback: () => number): Fn {
  return function (this: unknown, ...args: unknown[]) {
    const options = args[0] as Options | null
    if (options === null || typeof options !== 'object' || options['unix'] != null) return original.apply(Bun, args)
    const port = toPort(options['port']) ?? fallback()
    const path = prepare(port)
    const server = original.call(Bun, onSocket(options, path), ...args.slice(1)) as Options
    live.add(path)
    const stop = server['stop'] as Fn
    const release = controlled(() => (server['stop'] as Fn)())
    server['stop'] = function (...rest: unknown[]) {
      live.delete(path)
      release()
      return stop.apply(server, rest)
    }
    return looksBound(server, port, options['hostname'] as string | undefined)
  }
}

function patchBun(): void {
  if (typeof Bun === 'undefined') return
  const bun = Bun as unknown as Record<string, Fn>
  bun['serve'] = onUnix(bun['serve']!, envPort)
  bun['listen'] = onUnix(bun['listen']!, () => 0)

  const udp = bun['udpSocket']
  if (udp) {
    bun['udpSocket'] = function (this: unknown, ...args: unknown[]) {
      const options = args[0] as Options | null
      if (options && typeof options === 'object' && toPort(options['port'])) {
        refuse(`UDP socket on port ${String(options['port'])}`)
      }
      return udp.apply(Bun, args)
    }
  }
}

function nodeArgs(args: unknown[]): { port: number; host: string | undefined; options: Options; cb: unknown[] } | null {
  const rest = [...args]
  const cb = typeof rest.at(-1) === 'function' ? [rest.pop()] : []
  const first = rest[0]
  if (first !== null && typeof first === 'object') {
    const o = first as Options
    if (o['path'] != null) return null
    if ('fd' in o || '_handle' in o || first instanceof net.Server || first instanceof net.Socket) {
      refuse('listen on a handle or file descriptor')
    }
    const options: Options = {}
    for (const key of ['backlog', 'exclusive', 'readableAll', 'writableAll', 'signal']) {
      if (o[key] !== undefined) options[key] = o[key]
    }
    return { port: toPort(o['port']) ?? 0, host: typeof o['host'] === 'string' ? o['host'] : undefined, options, cb }
  }
  if (typeof first === 'string' && !(Number(first) >= 0)) return null
  const options: Options = {}
  const backlog = rest.slice(1).find((arg) => typeof arg === 'number')
  if (backlog !== undefined) options['backlog'] = backlog
  return { port: toPort(first) ?? 0, host: typeof rest[1] === 'string' ? rest[1] : undefined, options, cb }
}

type Mapped = NonNullable<ReturnType<typeof nodeArgs>>

function listenChannel(server: NetServer, mapped: Mapped): NetServer {
  const { port } = mapped
  const host = mapped.host && net.isIP(mapped.host) ? mapped.host : '::'
  for (const cb of mapped.cb) server.once('listening', cb as () => void)
  if (!serveChannel(port, (socket) => void server.emit('connection', socket), () => server.close())) {
    const message = `acde: listen EADDRINUSE: port ${port} is already served`
    const taken = Object.assign(new Error(message), { code: 'EADDRINUSE' })
    process.nextTick(() => server.emit('error', taken))
    return server
  }
  let listening = true
  const close = (Object.getPrototypeOf(server) as { close: Fn }).close
  const stop = () => {
    if (!listening) return false
    listening = false
    unserveChannel(port)
    return true
  }
  Object.defineProperties(server, {
    listening: { configurable: true, get: () => listening },
    address: {
      configurable: true,
      writable: true,
      value: () => (listening ? { address: host, family: net.isIPv6(host) ? 'IPv6' : 'IPv4', port } : null),
    },
    close: {
      configurable: true,
      writable: true,
      value: function (this: NetServer, cb?: (error?: Error) => void) {
        const was = stop()
        if (typeof cb === 'function') {
          const notRunning = Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })
          this.once('close', () => (was ? cb() : cb(notRunning)))
        }
        return close.call(this)
      },
    },
  })
  const signal = mapped.options['signal'] as AbortSignal | undefined
  if (signal?.aborted) stop()
  else signal?.addEventListener('abort', () => server.close(), { once: true })
  process.nextTick(() => (listening ? server.emit('listening') : undefined))
  return server
}

const patched = new WeakSet<object>()

function patchListen(proto: object): void {
  if (!Object.hasOwn(proto, 'listen') || patched.has(proto)) return
  patched.add(proto)
  const target = proto as { listen: Fn }
  const listen = target.listen
  target.listen = function (this: NetServer, ...args: unknown[]) {
    const mapped = nodeArgs(args)
    if (!mapped) return listen.apply(this, args)
    if (channelMode(process.env, typeof Bun !== 'undefined')) return listenChannel(this, mapped)
    const path = prepare(mapped.port)
    const server = this as NetServer & { address: Fn }
    delete (server as Partial<typeof server>).address
    const address = server.address
    const host = mapped.host && net.isIP(mapped.host) ? mapped.host : '::'
    Object.defineProperty(server, 'address', {
      configurable: true,
      writable: true,
      value: function (this: NetServer) {
        const real = address.call(this)
        return real == null ? real : { address: host, family: net.isIPv6(host) ? 'IPv6' : 'IPv4', port: mapped.port }
      },
    })
    server.once('listening', () => {
      live.add(path)
      const release = controlled(() => new Promise((done) => server.close(done)))
      server.once('close', release)
    })
    server.once('close', () => live.delete(path))
    return listen.call(this, { ...mapped.options, path }, ...mapped.cb)
  }
}

function patchUdp(): void {
  const proto = dgram.Socket.prototype as unknown as { bind: Fn }
  const bind = proto.bind
  proto.bind = function (this: UdpSocket, ...args: unknown[]) {
    const first = args[0]
    const port =
      first !== null && typeof first === 'object' ? (first as Options)['port'] : typeof first === 'function' ? 0 : first
    if (toPort(port)) refuse(`UDP bind to port ${String(port)}`)
    return bind.apply(this, args)
  }
}

interface FetchApp {
  fetch(this: FetchApp, request: Request, server: object): unknown
  error?(this: FetchApp, error: unknown): unknown
  port?: unknown
  hostname?: unknown
  unix?: unknown
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'http2-settings', 'proxy-connection'])

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers()
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!
    if (name.startsWith(':') || HOP.has(name.toLowerCase())) continue
    try {
      headers.append(name, req.rawHeaders[i + 1]!)
    } catch {}
  }
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? null : (Readable.toWeb(req) as ReadableStream<Uint8Array>)
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal, ...(body && { body, duplex: 'half' }) }
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`).href, init)
}

async function send(response: Response, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const head: string[] = []
  for (const [name, value] of response.headers) if (name !== 'set-cookie') head.push(name, value)
  for (const cookie of response.headers.getSetCookie()) head.push('set-cookie', cookie)
  res.writeHead(response.status, response.statusText || undefined, head)
  if (!response.body || req.method === 'HEAD') {
    res.end()
    await response.body?.cancel().catch(() => undefined)
    return
  }
  const reader = response.body.getReader()
  res.once('close', () => {
    if (!res.writableFinished) reader.cancel().catch(() => undefined)
  })
  const writable = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done)
        res.off('close', done)
        resolve()
      }
      res.on('drain', done)
      res.on('close', done)
    })
  for (;;) {
    const { done, value } = await reader.read()
    if (done || res.destroyed) break
    if (!res.write(value)) await writable()
  }
  if (!res.destroyed) res.end()
}

async function respond(app: FetchApp, server: object, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const aborted = new AbortController()
  res.once('close', () => {
    if (!res.writableFinished) aborted.abort()
  })
  try {
    let response: unknown
    try {
      response = await app.fetch(toRequest(req, aborted.signal), server)
    } catch (error) {
      if (typeof app.error !== 'function') throw error
      response = await app.error(error)
    }
    if (res.destroyed) return
    if (!(response instanceof Response)) {
      const got = response === undefined ? 'nothing' : typeof response
      throw new TypeError(`acde: the fetch handler returned ${got}, not a Response`)
    }
    await send(response, req, res)
  } catch (error) {
    console.error(error)
    if (res.headersSent) res.destroy()
    else res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error')
  }
}

function serve(app: FetchApp): object | undefined {
  if (!app || typeof app.fetch !== 'function') return undefined
  const port = toPort(app.port) ?? envPort()
  const hostname = typeof app.hostname === 'string' ? app.hostname : 'localhost'
  const facade = { upgrade: () => false, requestIP: () => null, port, hostname }
  const server = http.createServer((req, res) => void respond(app, facade, req, res))
  if (typeof app.unix === 'string' && app.unix) server.listen(app.unix)
  else if (typeof app.hostname === 'string' && app.hostname) server.listen(port, app.hostname)
  else server.listen(port)
  return server
}

const global = globalThis as Record<symbol, unknown>
if (!global[INSTALLED]) {
  global[INSTALLED] = CHANNEL_MARK
  if (typeof Bun === 'undefined') global[SERVE] = serve
  patchBun()
  for (const Server of [net.Server, http.Server, https.Server, tls.Server]) patchListen(Server.prototype)
  patchUdp()
}
