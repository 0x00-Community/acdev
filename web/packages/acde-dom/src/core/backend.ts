export type Header = [name: string, value: string]

export type HttpEvent =
  | { type: 'head'; status: number; statusText: string; headers: Header[] }
  | { type: 'chunk'; data: Uint8Array }
  | { type: 'end' }
  | { type: 'error'; message: string }

export type WsEvent =
  | { type: 'open'; protocol: string; extensions: string }
  | { type: 'message'; text?: string; data?: Uint8Array }
  | { type: 'close'; code: number; reason: string; wasClean: boolean }
  | { type: 'error'; message: string }

export interface BackendTransport {
  readonly port: number
  request(port: number, method: string, path: string, headers: Header[], body: Uint8Array | null, onEvent: (event: HttpEvent) => void): number | Promise<number>
  abort(id: number): unknown
  websocket(port: number, path: string, headers: Header[], protocols: string[], onEvent: (event: WsEvent) => void): number | Promise<number>
  send(id: number, data: string | Uint8Array): unknown
  close(id: number, code?: number, reason?: string): unknown
}

export let transport: BackendTransport | null = null

export function installBackendTransport(given: BackendTransport | null): void {
  transport = given
}

export interface BackendTarget {
  readonly port: number
  readonly path: string
  readonly host: string
}

type UrlParts = { readonly protocol: string; readonly host: string; readonly hostname: string; readonly port: string; readonly pathname: string; readonly search: string }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
const SECURE: Record<string, boolean> = { 'http:': false, 'ws:': false, 'https:': true, 'wss:': true }

export function backendTarget(url: UrlParts, own: UrlParts): BackendTarget | null {
  if (!transport || !(url.protocol in SECURE)) return null
  const path = (url.pathname || '/') + url.search
  if (url.host === own.host && SECURE[url.protocol] === SECURE[own.protocol]) return { port: transport.port, path, host: 'localhost' }
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return null
  const port = url.port ? Number(url.port) : SECURE[url.protocol] ? 443 : 80
  return { port, path, host: url.port ? `localhost:${port}` : 'localhost' }
}

const FORBIDDEN = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'cookie', 'cookie2', 'origin', 'expect', 'proxy-connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'])

export function requestHeaders(page: Iterable<readonly [string, string]>, target: BackendTarget, options: { origin: boolean; cookies: boolean }): Header[] {
  const out: Header[] = [['host', target.host]]
  for (const [name, value] of page) if (!FORBIDDEN.has(name.toLowerCase()) && !name.toLowerCase().startsWith('proxy-') && !name.toLowerCase().startsWith('sec-')) out.push([name, value])
  if (options.origin) out.push(['origin', `http://${target.host}`])
  const cookie = options.cookies ? cookies.header(target.path) : ''
  if (cookie) out.push(['cookie', cookie])
  return out
}

interface Cookie {
  readonly name: string
  readonly value: string
  readonly path: string
  readonly expires: number | null
  readonly httpOnly: boolean
  readonly created: number
}

function pathOf(target: string): string {
  const q = target.search(/[?#]/)
  return q < 0 ? target : target.slice(0, q)
}

function defaultPath(target: string): string {
  const path = pathOf(target)
  if (!path.startsWith('/')) return '/'
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true
  if (!path.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/'
}

let created = 0

export const cookies = {
  jar: new Map<string, Cookie>(),

  store(line: string, target: string, script = false): void {
    const [pair = '', ...attributes] = String(line).split(';')
    const eq = pair.indexOf('=')
    const name = eq < 0 ? '' : pair.slice(0, eq).trim()
    const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim()
    if (!name && !value) return
    let path: string | null = null
    let expires: number | null = null
    let maxAge: number | null = null
    let httpOnly = false
    for (const attribute of attributes) {
      const at = attribute.indexOf('=')
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
      const val = at < 0 ? '' : attribute.slice(at + 1).trim()
      if (key === 'path' && val.startsWith('/')) path = val
      else if (key === 'expires') {
        const time = Date.parse(val)
        if (!Number.isNaN(time)) expires = time
      } else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val)
      else if (key === 'httponly') httpOnly = true
    }
    if (maxAge !== null) expires = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000
    path ??= defaultPath(target)
    const key = `${name}\n${path}`
    const old = cookies.jar.get(key)
    if (script && (httpOnly || old?.httpOnly)) return
    if (expires !== null && expires <= Date.now()) {
      cookies.jar.delete(key)
      return
    }
    cookies.jar.set(key, { name, value, path, expires, httpOnly, created: old?.created ?? created++ })
  },

  header(target: string, script = false): string {
    const path = pathOf(target) || '/'
    const now = Date.now()
    const out: Cookie[] = []
    for (const [key, cookie] of cookies.jar) {
      if (cookie.expires !== null && cookie.expires <= now) {
        cookies.jar.delete(key)
        continue
      }
      if ((script && cookie.httpOnly) || !pathMatches(path, cookie.path)) continue
      out.push(cookie)
    }
    out.sort((a, b) => b.path.length - a.path.length || a.created - b.created)
    return out.map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; ')
  },
}
