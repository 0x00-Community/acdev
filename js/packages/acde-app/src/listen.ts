import dgram from 'node:dgram'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname } from 'node:path'
import tls from 'node:tls'
import { socketPath } from './sockets.ts'

type Fn = (...args: unknown[]) => unknown
type Options = Record<PropertyKey, unknown>

const INSTALLED = Symbol.for('acde.listen')
const live = new Set<string>()

function toPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const port = typeof value === 'string' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`acde: bad port ${String(value)}`)
  }
  return port
}

function refuse(what: string): never {
  throw Object.assign(new Error(`acde: ${what}: an acde app listens on unix sockets only`), { code: 'EACCES' })
}

function prepare(port: number): string {
  const path = socketPath(port)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (!live.has(path)) {
    try {
      if (lstatSync(path).isSocket()) unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return path
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
    server['stop'] = function (...rest: unknown[]) {
      live.delete(path)
      return stop.apply(server, rest)
    }
    return looksBound(server, port, options['hostname'] as string | undefined)
  }
}

function patchBun(): void {
  if (typeof Bun === 'undefined') return
  const bun = Bun as unknown as Record<string, Fn>
  const env = process.env
  bun['serve'] = onUnix(bun['serve']!, () => toPort(env['BUN_PORT']) ?? toPort(env['PORT']) ?? toPort(env['NODE_PORT']) ?? 3000)
  bun['listen'] = onUnix(bun['listen']!, () => 0)

  const udp = bun['udpSocket']
  if (udp) {
    bun['udpSocket'] = function (this: unknown, ...args: unknown[]) {
      const options = args[0] as Options | null
      if (options && typeof options === 'object' && toPort(options['port'])) refuse(`UDP socket on port ${String(options['port'])}`)
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

const patched = new WeakSet<object>()

function patchListen(proto: object): void {
  if (!Object.hasOwn(proto, 'listen') || patched.has(proto)) return
  patched.add(proto)
  const target = proto as { listen: Fn }
  const listen = target.listen
  target.listen = function (this: net.Server, ...args: unknown[]) {
    const mapped = nodeArgs(args)
    if (!mapped) return listen.apply(this, args)
    const path = prepare(mapped.port)
    const server = this as net.Server & { address: Fn }
    delete (server as Partial<typeof server>).address
    const address = server.address
    const host = mapped.host && net.isIP(mapped.host) ? mapped.host : '::'
    Object.defineProperty(server, 'address', {
      configurable: true,
      writable: true,
      value: function (this: net.Server) {
        const real = address.call(this)
        return real == null ? real : { address: host, family: net.isIPv6(host) ? 'IPv6' : 'IPv4', port: mapped.port }
      },
    })
    server.once('listening', () => live.add(path))
    server.once('close', () => live.delete(path))
    return listen.call(this, { ...mapped.options, path }, ...mapped.cb)
  }
}

function patchUdp(): void {
  const proto = dgram.Socket.prototype as unknown as { bind: Fn }
  const bind = proto.bind
  proto.bind = function (this: dgram.Socket, ...args: unknown[]) {
    const first = args[0]
    const port = first !== null && typeof first === 'object' ? (first as Options)['port'] : typeof first === 'function' ? 0 : first
    if (toPort(port)) refuse(`UDP bind to port ${String(port)}`)
    return bind.apply(this, args)
  }
}

const global = globalThis as Record<symbol, unknown>
if (!global[INSTALLED]) {
  global[INSTALLED] = true
  patchBun()
  for (const Server of [net.Server, http.Server, https.Server, tls.Server]) patchListen(Server.prototype)
  patchUdp()
}
