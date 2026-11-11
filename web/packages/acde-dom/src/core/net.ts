import { Blob, blobBytes } from './blob'
import {
  allowedHeaders, backendTarget, cookies, dialOf, isRemote, requestHeaders, transport,
  type Header, type HttpEvent, type RemoteTarget, type Target, type WsEvent,
} from './backend'
import { Cors } from './cors'
import { mocked, Tracked, type MockReply, type RequestKind } from './observe'
import { bytesOf, concat, TextDecoder, unbase64 } from './encoding'
import { CloseEvent, defineHandlers, Event, EventTarget, fire, MessageEvent, ProgressEvent } from './event'
import { DOMException } from './exception'
import { constants, G, getters, host, tag } from './host'
import { isDisturbed, readAllBytes, ReadableStream, streamOfBytes, type ReadableStreamDefaultController } from './streams'
import { objectUrls, URL, URLSearchParams } from './url'

export const net = {
  base: () => 'http://acde.local/',
  log: true,
}

const TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
}

export function typeOfName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  return TYPES[ext] ?? ''
}

const warned = new Set<string>()

function warnOnce(method: string, url: string, what: string): void {
  let key: string
  try {
    const parsed = new URL(url)
    key = `${method} ${parsed.origin === new URL(net.base()).origin ? '' : parsed.origin}${parsed.pathname}`
  } catch {
    key = `${method} ${url}`
  }
  if (!net.log || warned.has(`${key}\n${what}`)) return
  warned.add(`${key}\n${what}`)
  host.print(1, `acde-dom: ${key}: ${what}`)
}

function backendFailed(method: string, url: string, message: string): void {
  let target: Target | null = null
  try {
    target = backendTarget(new URL(url), new URL(net.base()))
  } catch {
  }
  warnOnce(method, url, target && !isRemote(target) ? `the app's backend: ${message}` : message)
}

function quality(languages: readonly string[]): string {
  return languages.map((tag, i) => (i ? `${tag};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}` : tag)).join(',')
}

function browserHeaders(page: readonly Header[], accept: boolean): Header[] {
  const out: Header[] = [...page]
  const has = (name: string) => out.some(([n]) => n.toLowerCase() === name)
  const navigator = G['navigator'] as { userAgent?: string; languages?: readonly string[] } | undefined
  if (accept && !has('accept')) out.push(['accept', '*/*'])
  if (!has('accept-language') && navigator?.languages?.length) out.push(['accept-language', quality(navigator.languages)])
  if (!has('user-agent') && navigator?.userAgent) out.push(['user-agent', navigator.userAgent])
  return out
}

type Loaded = { bytes: Uint8Array; type: string }
type Routed = { target: Target } | { asset: Loaded } | null

export function unreachable(url: string): string {
  try {
    if (new URL(url).origin === new URL(net.base()).origin) return 'no such file in the app, and no backend to ask'
  } catch {
  }
  return 'another host, and this page has no network'

}

function inline(url: string): Loaded | null {
  if (url.startsWith('blob:')) {
    const hash = url.indexOf('#')
    const blob = objectUrls.get(hash < 0 ? url : url.slice(0, hash))
    return blob instanceof Blob ? { bytes: blobBytes(blob), type: blob.type } : null
  }
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const meta = url.slice(5, comma)
  const body = url.slice(comma + 1)
  const base64 = /;base64$/i.test(meta)
  const bytes = base64 ? unbase64(decodeURIComponent(body)) : host.encodeUtf8(decodeURIComponent(body))
  return bytes ? { bytes, type: meta.replace(/;base64$/i, '') || 'text/plain;charset=US-ASCII' } : null
}

export function route(url: string, method: string): Routed {
  const connection = method === 'WS' || method === 'SSE'
  if (!connection && (url.startsWith('data:') || url.startsWith('blob:'))) {
    const found = inline(url)
    return found && { asset: found }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const own = new URL(net.base())
  if (!connection && parsed.origin === own.origin && (method === 'GET' || method === 'HEAD')) {
    const bytes = host.readAsset(parsed.href)
    if (bytes) return { asset: { bytes, type: typeOfName(parsed.pathname) || 'application/octet-stream' } }
  }
  const target = backendTarget(parsed, own)
  if (target) return { target }
  warnOnce(method, url, 'no network; refused')
  return null
}

function assetHead(found: Loaded): Header[] {
  return [['content-length', String(found.bytes.length)], ['content-type', found.type]]
}

type HeadersInit = Headers | Record<string, string> | Iterable<readonly [string, string]>

export class Headers {
  #map = new Map<string, string>()
  #cookies: string[] = []

  constructor(init?: HeadersInit | null) {
    if (!init) return
    if (init instanceof Headers) for (const [k, v] of init) this.append(k, v)
    else if (typeof (init as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const [k, v] of init as Iterable<readonly [string, string]>) this.append(k, v)
    }
    else for (const k of Object.keys(init)) this.append(k, (init as Record<string, string>)[k]!)
  }

  append(name: string, value: string): void {
    const key = String(name).toLowerCase()
    const v = String(value).trim()
    if (key === 'set-cookie') return void this.#cookies.push(v)
    const old = this.#map.get(key)
    this.#map.set(key, old === undefined ? v : `${old}, ${v}`)
  }
  set(name: string, value: string): void {
    const key = String(name).toLowerCase()
    if (key === 'set-cookie') this.#cookies = [String(value).trim()]
    else this.#map.set(key, String(value).trim())
  }
  get(name: string): string | null {
    const key = String(name).toLowerCase()
    if (key === 'set-cookie') return this.#cookies.length ? this.#cookies.join(', ') : null
    return this.#map.get(key) ?? null
  }
  getSetCookie(): string[] {
    return [...this.#cookies]
  }
  has(name: string): boolean {
    const key = String(name).toLowerCase()
    return key === 'set-cookie' ? this.#cookies.length > 0 : this.#map.has(key)
  }
  delete(name: string): void {
    const key = String(name).toLowerCase()
    if (key === 'set-cookie') this.#cookies = []
    else this.#map.delete(key)
  }
  forEach(callback: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
    for (const [k, v] of this) callback.call(thisArg, v, k, this)
  }
  *entries(): IterableIterator<[string, string]> {
    const all: [string, string][] = [...this.#map, ...this.#cookies.map((v): [string, string] => ['set-cookie', v])]
    yield* all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }
  *keys(): IterableIterator<string> {
    for (const [k] of this.entries()) yield k
  }
  *values(): IterableIterator<string> {
    for (const [, v] of this.entries()) yield v
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }
}
tag(Headers)

function visibleHeaders(headers: readonly Header[]): Header[] {
  return headers.filter(([name]) => !/^set-cookie2?$/i.test(name))
}

export function headerOf(headers: readonly Header[], name: string): string | null {
  const values = headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v)
  return values.length ? values.join(', ') : null
}

interface FormDataLike {
  entries(): IterableIterator<[string, string | Blob]>
}

function isFormData(value: unknown): value is FormDataLike {
  return typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object FormData]'
}

type BodyInit = string | ArrayBuffer | ArrayBufferView | Blob | URLSearchParams | ReadableStream<Uint8Array> | FormDataLike | null | undefined

function multipart(form: FormDataLike): { bytes: Uint8Array; type: string } {
  const random = new Uint8Array(12)
  host.randomBytes(random)
  const boundary = `----acdeFormBoundary${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  const quote = (text: string) => text.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
  const parts: Uint8Array[] = []
  for (const [name, value] of form.entries()) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"`
    if (value instanceof Blob) {
      const filename = (value as Blob & { name?: string }).name ?? 'blob'
      head += `; filename="${quote(filename)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`
      parts.push(host.encodeUtf8(head), blobBytes(value), host.encodeUtf8('\r\n'))
    } else parts.push(host.encodeUtf8(`${head}\r\n\r\n${String(value).replace(/\r?\n|\r/g, '\r\n')}\r\n`))
  }
  parts.push(host.encodeUtf8(`--${boundary}--\r\n`))
  return { bytes: concat(parts), type: `multipart/form-data; boundary=${boundary}` }
}

function extractBody(body: BodyInit): { bytes: Uint8Array | null; stream: ReadableStream<Uint8Array> | null; type: string | null } {
  if (body === null || body === undefined) return { bytes: null, stream: null, type: null }
  if (typeof body === 'string') return { bytes: host.encodeUtf8(body), stream: null, type: 'text/plain;charset=UTF-8' }
  if (body instanceof Blob) return { bytes: blobBytes(body), stream: null, type: body.type || null }
  if (body instanceof URLSearchParams) return { bytes: host.encodeUtf8(body.toString()), stream: null, type: 'application/x-www-form-urlencoded;charset=UTF-8' }
  if (body instanceof ReadableStream) return { bytes: null, stream: body, type: null }
  if (isFormData(body)) {
    const { bytes, type } = multipart(body)
    return { bytes, stream: null, type }
  }
  return { bytes: bytesOf(body as ArrayBuffer).slice(), stream: null, type: null }
}

const SEND = Symbol('send')

class Body {
  #bytes: Uint8Array | null
  #stream: ReadableStream<Uint8Array> | null
  #used = false

  constructor(bytes: Uint8Array | null, stream: ReadableStream<Uint8Array> | null = null) {
    this.#bytes = bytes
    this.#stream = stream
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (!this.#stream && this.#bytes) {
      this.#stream = streamOfBytes(this.#bytes)
      this.#bytes = null
    }
    return this.#stream
  }
  get bodyUsed(): boolean {
    return this.#used || (!!this.#stream && isDisturbed(this.#stream))
  }

  protected bodyForClone(): { bytes: Uint8Array | null; stream: ReadableStream<Uint8Array> | null } {
    if (this.#stream) {
      const [mine, theirs] = this.#stream.tee()
      this.#stream = mine
      return { bytes: null, stream: theirs }
    }
    return { bytes: this.#bytes, stream: null }
  }

  async #consume(): Promise<Uint8Array> {
    if (this.bodyUsed) throw new TypeError('Failed to execute: body stream already read')
    const stream = this.body
    if (!stream) return new Uint8Array(0)
    if (stream.locked) throw new TypeError('Failed to execute: body stream is locked')
    this.#used = true
    return readAllBytes(stream, true)
  }

  [SEND](): Promise<Uint8Array | null> {
    if (!this.#stream && !this.#bytes) return Promise.resolve(null)
    return this.#consume()
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.#consume())
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text())
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.#consume()).slice().buffer
  }
  async bytes(): Promise<Uint8Array> {
    return (await this.#consume()).slice()
  }
  async blob(): Promise<Blob> {
    const bytes = await this.#consume()
    return new Blob([bytes], { type: (this as unknown as { headers: Headers }).headers.get('content-type') ?? '' })
  }
  async formData(): Promise<FormDataLike> {
    const type = (this as unknown as { headers: Headers }).headers.get('content-type') ?? ''
    const FormData = G['FormData'] as (new () => FormDataLike & { append(name: string, value: unknown, filename?: string): void }) | undefined
    if (!FormData) throw new TypeError('formData() needs FormData')
    const bytes = await this.#consume()
    const form = new FormData()
    if (/^application\/x-www-form-urlencoded\b/i.test(type)) {
      for (const [name, value] of new URLSearchParams(new TextDecoder().decode(bytes))) form.append(name, value)
      return form
    }
    const boundary = /^multipart\/form-data\b.*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type)
    if (!boundary) throw new TypeError(`formData(): not a form (${type || 'no content type'})`)
    for (const part of multipartParts(bytes, boundary[1] ?? boundary[2]!)) {
      const disposition = /\bname="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(part.headers['content-disposition'] ?? '')
      if (!disposition) continue
      const name = disposition[1]!
      if (disposition[2] === undefined) form.append(name, new TextDecoder().decode(part.body))
      else form.append(name, new Blob([part.body], { type: part.headers['content-type'] ?? 'application/octet-stream' }), disposition[2])
    }
    return form
  }
}

function multipartParts(bytes: Uint8Array, boundary: string): { headers: Record<string, string>; body: Uint8Array }[] {
  const find = (needle: Uint8Array, from: number): number => {
    outer: for (let i = from; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }
  const delimiter = host.encodeUtf8(`--${boundary}`)
  const parts: { headers: Record<string, string>; body: Uint8Array }[] = []
  let at = find(delimiter, 0)
  while (at >= 0) {
    let start = at + delimiter.length
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break
    if (bytes[start] === 0x0d) start += 2
    const headEnd = find(host.encodeUtf8('\r\n\r\n'), start)
    if (headEnd < 0) break
    const next = find(host.encodeUtf8(`\r\n--${boundary}`), headEnd + 4)
    if (next < 0) break
    const headers: Record<string, string> = {}
    for (const line of new TextDecoder().decode(bytes.subarray(start, headEnd)).split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    parts.push({ headers, body: bytes.slice(headEnd + 4, next) })
    at = next + 2
  }
  return parts
}

interface RequestInit {
  method?: string
  headers?: HeadersInit
  body?: BodyInit
  signal?: unknown
  cache?: string
  credentials?: string
  redirect?: string
  duplex?: string
  mode?: string
  keepalive?: boolean
}

export class Request extends Body {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly signal: unknown
  readonly mode: string
  readonly credentials: string
  readonly cache: string
  readonly redirect: string
  readonly referrer = 'about:client'
  readonly referrerPolicy = ''
  readonly integrity = ''
  readonly keepalive = false
  readonly destination = ''

  constructor(input: string | URL | Request, init?: RequestInit) {
    const base = input instanceof Request ? input : null
    const { bytes, stream, type } = extractBody(init?.body)
    const inherited = init?.body === undefined && base ? base.bodyForClone() : null
    super(inherited ? inherited.bytes : bytes, inherited ? inherited.stream : stream)
    const parsed = base ? null : new URL(String(input), net.base())
    if (parsed && (parsed.username || parsed.password)) {
      throw new TypeError(`Failed to construct 'Request': Request cannot be constructed from a URL that includes credentials: ${String(input)}`)
    }
    this.url = base ? base.url : parsed!.href
    this.method = String(init?.method ?? base?.method ?? 'GET').toUpperCase()
    this.headers = new Headers(init?.headers ?? base?.headers)
    if (type && !this.headers.has('content-type')) this.headers.set('content-type', type)
    this.signal = init?.signal ?? base?.signal ?? null
    this.cache = init?.cache ?? 'default'
    this.credentials = init?.credentials ?? base?.credentials ?? 'same-origin'
    this.redirect = init?.redirect ?? base?.redirect ?? 'follow'
    this.mode = init?.mode ?? base?.mode ?? 'cors'
    if (!['cors', 'no-cors', 'same-origin'].includes(this.mode)) {
      throw new TypeError(`Failed to construct 'Request': Cannot construct a Request with a RequestInit whose mode member is set as '${this.mode}'.`)
    }
    if (this.mode === 'no-cors' && !Cors.simpleMethod(this.method)) {
      throw new TypeError(`Failed to construct 'Request': '${this.method}' is unsupported in no-cors mode.`)
    }
  }

  clone(): Request {
    return new Request(this)
  }
}
tag(Request)

type ResponseInit = { status?: number; statusText?: string; headers?: HeadersInit }

export class Response extends Body {
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly type: string
  url = ''
  readonly redirected = false

  constructor(body?: BodyInit, init?: ResponseInit) {
    const { bytes, stream, type } = extractBody(body)
    super(bytes, stream)
    this.status = init?.status ?? 200
    if (this.status < 200 || this.status > 599) {
      throw new RangeError(`Failed to construct 'Response': The status provided (${this.status}) is outside the range [200, 599].`)
    }
    this.statusText = init?.statusText ?? ''
    this.headers = new Headers(init?.headers)
    if (type && !this.headers.has('content-type')) this.headers.set('content-type', type)
    this.type = 'default'
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  clone(): Response {
    if (this.bodyUsed) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used")
    const { bytes, stream } = this.bodyForClone()
    const inRange = this.status >= 200 && this.status <= 599
    const copy = new Response(stream ?? bytes, { status: inRange ? this.status : 200, statusText: this.statusText, headers: this.headers })
    if (!inRange) Object.defineProperty(copy, 'status', { value: this.status })
    if (this.type !== 'default') Object.defineProperty(copy, 'type', { value: this.type })
    copy.url = this.url
    if (this.redirected) Object.defineProperty(copy, 'redirected', { value: true })
    return copy
  }

  static json(data: unknown, init?: ResponseInit): Response {
    const response = new Response(JSON.stringify(data), init)
    response.headers.set('content-type', 'application/json')
    return response
  }

  static error(): Response {
    const response = new Response(null)
    Object.defineProperty(response, 'status', { value: 0 })
    Object.defineProperty(response, 'type', { value: 'error' })
    return response
  }

  static redirect(url: string, status = 302): Response {
    return new Response(null, { status, headers: { location: new URL(url, net.base()).href } })
  }
}
tag(Response)

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NULL_BODY = new Set([101, 103, 204, 205, 304])
const BODY_HEADERS = new Set(['content-type', 'content-encoding', 'content-language', 'content-location', 'content-length'])

interface ExchangeHead {
  readonly status: number
  readonly statusText: string
  readonly headers: Header[]
  readonly url: string
  readonly redirected: boolean
  readonly type: 'basic' | 'cors' | 'opaque'
}

interface ExchangeHandlers {
  head(head: ExchangeHead): void
  chunk(data: Uint8Array): void
  end(): void
  error(message: string): void
}

interface ExchangeRequest {
  readonly url: string
  readonly method: string
  readonly headers: Iterable<readonly [string, string]>
  readonly body: Uint8Array | null
  readonly redirect: string
  readonly credentials: string
  readonly mode: string
}

function tracking(tracked: Tracked | null, given: ExchangeHandlers): ExchangeHandlers {
  if (!tracked) return given
  return {
    head(head) {
      tracked.response(head.status, head.statusText, head.headers)
      given.head(head)
    },
    chunk(data) {
      tracked.received(data.length, data)
      given.chunk(data)
    },
    end() {
      tracked.end()
      given.end()
    },
    error(message) {
      tracked.error(message)
      given.error(message)
    },
  }
}

export function exchange(first: Target, request: ExchangeRequest, given: ExchangeHandlers, kind: RequestKind): () => void {
  const backend = transport!
  const tracked = Tracked.start(kind, request.method, request.url, request.body?.length ?? 0, false, request.headers, request.body)
  const on = tracking(tracked, given)
  const withCookies = request.credentials !== 'omit'
  const include = request.credentials === 'include'
  const own = new URL(net.base()).origin
  let origin = own
  let current: number | null = null
  let finished = false
  let redirects = 0
  const fail = (message: string): void => {
    if (finished) return
    finished = true
    on.error(message)
  }
  const stop = (id: number | null): void => {
    if (id !== null) backend.abort(id)
  }
  const blocked = (problem: string): void => fail(`CORS: ${problem}`)
  const ask = (target: Target, method: string, headers: Header[], body: Uint8Array | null, onEvent: (event: HttpEvent) => void): number | null => {
    const [to, path] = dialOf(target)
    try {
      return backend.request(to, method, path, headers, body, onEvent)
    } catch (error) {
      host.queueMicrotask(() => fail(String((error as Error)?.message ?? error)))
      return null
    }
  }
  const listen = (
    target: Target, url: string, method: string, pageHeaders: Iterable<readonly [string, string]>, body: Uint8Array | null, mine: () => number | null,
    tainting: 'basic' | 'cors' | 'opaque',
  ) => (event: HttpEvent): void => {
    if (finished || current !== mine()) return
    switch (event.type) {
      case 'head': {
        const all = event.headers ?? []
        if (!isRemote(target) && withCookies) for (const [name, value] of all) if (name.toLowerCase() === 'set-cookie') cookies.store(value, target.path)
        const location = headerOf(all, 'location')
        const redirecting = REDIRECTS.has(event.status) && location !== null && request.redirect !== 'manual'
        if (tainting === 'cors') {
          const problem = Cors.check(all, origin, include)
          if (problem) {
            stop(current)
            current = null
            return blocked(problem)
          }
        }
        if (!redirecting) {
          if (tainting === 'opaque') {
            stop(current)
            current = null
            finished = true
            on.head({ status: 0, statusText: '', headers: [], url: '', redirected: false, type: 'opaque' })
            on.end()
            return
          }
          const headers = tainting === 'cors' ? Cors.exposed(all, include) : visibleHeaders(all)
          on.head({ status: event.status, statusText: event.statusText ?? '', headers, url, redirected: redirects > 0, type: tainting })
          return
        }
        stop(current)
        current = null
        if (request.redirect === 'error') return fail(`redirected to ${location}`)
        if (++redirects > 20) return fail('too many redirects')
        let next: string
        try {
          next = new URL(location!, url).href
        } catch {
          return fail(`redirected to an invalid URL ${location}`)
        }
        const toGet = (event.status === 303 && method !== 'HEAD') || ((event.status === 301 || event.status === 302) && method === 'POST')
        const nextMethod = toGet ? 'GET' : method
        const nextHeaders = toGet ? [...pageHeaders].filter(([n]) => !BODY_HEADERS.has(n.toLowerCase())) : pageHeaders
        const routed = route(next, nextMethod)
        if (routed && 'target' in routed) {
          if (isRemote(target) && isRemote(routed.target) && routed.target.origin !== target.origin) origin = 'null'
          return send(routed.target, next, nextMethod, nextHeaders, toGet ? null : body)
        }
        if (!routed) return fail(`redirected to ${next}, which cannot be reached`)
        finished = true
        on.head({ status: 200, statusText: 'OK', headers: assetHead(routed.asset), url: next, redirected: true, type: 'basic' })
        if (nextMethod !== 'HEAD') on.chunk(routed.asset.bytes)
        on.end()
        return
      }
      case 'chunk':
        return on.chunk(event.data)
      case 'end':
        finished = true
        return on.end()
      case 'error':
        return fail(event.message)
    }
  }
  const remote = (target: RemoteTarget, url: string, method: string, pageHeaders: Iterable<readonly [string, string]>, body: Uint8Array | null): void => {
    if (request.mode === 'same-origin') return fail(`mode 'same-origin' does not allow a request to ${target.origin}`)
    const page = allowedHeaders(pageHeaders)
    if (request.mode === 'script') {
      let mine: number | null = null
      const headers = browserHeaders(page, true).concat([['referer', `${own}/`]])
      current = mine = ask(target, method, headers, body, listen(target, url, method, pageHeaders, body, () => mine, 'basic'))
      return
    }
    const unsafe = Cors.unsafeNames(page)
    const simple = Cors.simpleMethod(method) && !unsafe.length
    const opaque = request.mode === 'no-cors'
    if (opaque && !simple) return fail("mode 'no-cors' allows only GET, HEAD and POST with CORS-safelisted headers")
    const headers = browserHeaders(page, true)
    if (!opaque || (method !== 'GET' && method !== 'HEAD')) headers.push(['origin', origin])
    headers.push(['referer', `${own}/`])
    const actual = (): void => {
      let mine: number | null = null
      current = mine = ask(target, method, headers, body, listen(target, url, method, pageHeaders, body, () => mine, opaque ? 'opaque' : 'cors'))
    }
    if (simple || opaque) return actual()
    const preflight: Header[] = [['accept', '*/*'], ['origin', origin], ['access-control-request-method', method]]
    if (unsafe.length) preflight.push(['access-control-request-headers', unsafe.join(',')])
    let mine: number | null = null
    const onPreflight = (event: HttpEvent): void => {
      if (finished || current !== mine) return
      if (event.type === 'error') return fail(event.message)
      if (event.type !== 'head') return
      stop(mine)
      current = null
      const all = event.headers ?? []
      const problem = event.status < 200 || event.status > 299
        ? `It does not have HTTP ok status (${event.status}).`
        : (Cors.check(all, origin, include) ?? Cors.preflight(all, method, unsafe, include))
      if (problem) return blocked(`Response to preflight request doesn't pass access control check: ${problem}`)
      actual()
    }
    current = mine = ask(target, 'OPTIONS', browserHeaders(preflight, false).concat([['referer', `${own}/`]]), null, onPreflight)
  }
  const send = (target: Target, url: string, method: string, pageHeaders: Iterable<readonly [string, string]>, body: Uint8Array | null): void => {
    if (isRemote(target)) return remote(target, url, method, pageHeaders, body)
    const headers = requestHeaders(pageHeaders, target, { origin: method !== 'GET' && method !== 'HEAD', cookies: withCookies })
    if (!headers.some(([n]) => n.toLowerCase() === 'accept')) headers.push(['accept', '*/*'])
    let mine: number | null = null
    current = mine = ask(target, method, headers, body, listen(target, url, method, pageHeaders, body, () => mine, 'basic'))
  }
  send(first, request.url, request.method, request.headers, request.body)
  return () => {
    if (finished) return
    finished = true
    tracked?.error('aborted')
    stop(current)
  }
}

type SignalLike = {
  aborted?: boolean
  reason?: unknown
  addEventListener?: (t: string, f: () => void) => void
  removeEventListener?: (t: string, f: () => void) => void
}

function aborted(signal: SignalLike): unknown {
  return signal.reason ?? new DOMException('The user aborted a request.', 'AbortError')
}

function assetResponse(request: Request, found: Loaded): Response {
  const response = new Response(request.method === 'HEAD' ? null : found.bytes, { status: 200, statusText: 'OK', headers: assetHead(found) })
  response.url = request.url
  return response
}

async function fetchBackend(request: Request, target: Target, signal: SignalLike | null, mode = request.mode): Promise<Response> {
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request[SEND]()
  if (signal?.aborted) throw aborted(signal)
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let response: Response | null = null
    const settle = (): void => signal?.removeEventListener?.('abort', onAbort)
    const { url, method, headers, redirect, credentials } = request
    const sent = { url, method, headers, body, redirect, credentials, mode }
    const abort = exchange(target, sent, {
      head(head) {
        if (head.type === 'opaque') {
          settle()
          response = new Response(null)
          Object.defineProperty(response, 'status', { value: 0 })
          Object.defineProperty(response, 'type', { value: 'opaque' })
          return resolve(response)
        }
        if (head.status < 200 || head.status > 599) {
          abort()
          settle()
          return reject(new TypeError('Failed to fetch', { cause: `status ${head.status}` }))
        }
        const empty = request.method === 'HEAD' || NULL_BODY.has(head.status)
        const stream = empty ? null : new ReadableStream<Uint8Array>({
          start: (c) => void (controller = c),
          cancel: () => {
            abort()
            settle()
          },
        }, { highWaterMark: 0 })
        response = new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers })
        response.url = head.url
        Object.defineProperty(response, 'type', { value: head.type })
        if (head.redirected) Object.defineProperty(response, 'redirected', { value: true })
        if (empty) settle()
        resolve(response)
      },
      chunk(data) {
        try {
          controller?.enqueue(data)
        } catch {
        }
      },
      end() {
        settle()
        try {
          controller?.close()
        } catch {
        }
      },
      error(message) {
        settle()
        backendFailed(request.method, request.url, message)
        const error = new TypeError(response ? 'network error' : 'Failed to fetch', { cause: message })
        if (!response) reject(error)
        else controller?.error(error)
      },
    }, 'fetch')
    const onAbort = (): void => {
      abort()
      settle()
      const reason = aborted(signal!)
      if (!response) reject(reason)
      else controller?.error(reason)
    }
    signal?.addEventListener?.('abort', onAbort)
  })
}

export async function scriptSource(url: string): Promise<string> {
  const routed = route(url, 'GET')
  if (!routed) throw new Error(`<script src=${url}>: ${unreachable(url)}`)
  if ('asset' in routed) return new TextDecoder().decode(routed.asset.bytes)
  const response = await fetchBackend(new Request(url), routed.target, null, 'script')
  if (!response.ok) throw new Error(`<script src=${url}>: HTTP ${response.status}`)
  return response.text()
}

function fetchMocked(request: Request, mock: MockReply, signal: SignalLike | null): Promise<Response> {
  const tracked = Tracked.start('fetch', request.method, request.url, 0, true, request.headers)
  return new Promise((resolve, reject) => {
    host.setTimer(0, () => {
      if (signal?.aborted) {
        tracked?.error('aborted')
        return reject(aborted(signal))
      }
      if ('error' in mock) {
        tracked?.error(mock.error)
        return reject(new TypeError('Failed to fetch', { cause: mock.error }))
      }
      const empty = request.method === 'HEAD' || NULL_BODY.has(mock.status)
      tracked?.response(mock.status, mock.statusText, mock.headers)
      if (!empty) tracked?.received(mock.body.length, mock.body)
      tracked?.end(empty ? 0 : mock.body.length)
      const response = new Response(empty ? null : mock.body, { status: mock.status, statusText: mock.statusText, headers: mock.headers as [string, string][] })
      response.url = request.url
      resolve(response)
    })
  })
}

export function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let request: Request
  try {
    request = new Request(input, init)
  } catch (error) {
    return Promise.reject(error instanceof TypeError ? error : new TypeError(String((error as Error)?.message ?? error)))
  }
  const signal = request.signal as SignalLike | null
  if (signal?.aborted) return Promise.reject(aborted(signal))
  const mock = mocked('fetch', request.method, request.url)
  if (mock) return fetchMocked(request, mock, signal)
  const routed = route(request.url, request.method)
  if (routed && 'target' in routed) return fetchBackend(request, routed.target, signal)
  const tracked = Tracked.start('fetch', request.method, request.url, 0, false, request.headers)
  return new Promise((resolve, reject) => {
    host.setTimer(0, () => {
      if (signal?.aborted) {
        tracked?.error('aborted')
        return reject(aborted(signal))
      }
      if (!routed) {
        tracked?.error(unreachable(request.url))
        return reject(new TypeError('Failed to fetch'))
      }
      tracked?.response(200, 'OK', assetHead(routed.asset))
      tracked?.received(routed.asset.bytes.length, routed.asset.bytes)
      tracked?.end(routed.asset.bytes.length)
      resolve(assetResponse(request, routed.asset))
    })
  })
}

export class XMLHttpRequestEventTarget extends EventTarget {}
defineHandlers(XMLHttpRequestEventTarget.prototype, ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'])
tag(XMLHttpRequestEventTarget)

export class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
tag(XMLHttpRequestUpload)

export class XMLHttpRequest extends XMLHttpRequestEventTarget {
  readyState = 0
  status = 0
  statusText = ''
  responseType = ''
  responseURL = ''
  timeout = 0
  withCredentials = false
  readonly upload = new XMLHttpRequestUpload()
  #method = 'GET'
  #url = ''
  #async = true
  #chunks: Uint8Array[] = []
  #bytes: Uint8Array | null = null
  #type = ''
  #responseHeaders: Header[] | null = null
  #headers = new Headers()
  #sent = 0
  #stop: (() => void) | null = null

  open(method: string, url: string, async = true): void {
    this.#stop?.()
    this.#stop = null
    this.#sent++
    this.#method = String(method).toUpperCase()
    this.#url = new URL(String(url), net.base()).href
    this.#async = async !== false
    this.#bytes = null
    this.#chunks = []
    this.#responseHeaders = null
    this.#headers = new Headers()
    this.status = 0
    this.statusText = ''
    this.#state(1)
  }

  setRequestHeader(name: string, value: string): void {
    if (this.readyState !== 1) {
      throw new DOMException("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError')
    }
    this.#headers.append(name, value)
  }

  #state(state: number): void {
    this.readyState = state
    fire(this, new Event('readystatechange'))
  }

  send(body?: BodyInit): void {
    if (this.readyState !== 1) throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError')
    const token = ++this.#sent
    const mock = mocked('xhr', this.#method, this.#url)
    if (mock) return this.#mocked(mock, token)
    const routed = route(this.#url, this.#method)
    if (routed && 'target' in routed) {
      if (!this.#async) {
        const what = `synchronous requests to the app's backend or the network are not supported ('${this.#url}').`
        throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': ${what}`, 'NetworkError')
      }
      fire(this, new ProgressEvent('loadstart'))
      return this.#backend(routed.target, token, body)
    }
    const tracked = Tracked.start('xhr', this.#method, this.#url, 0, false, this.#headers)
    const finish = () => {
      if (token !== this.#sent) return tracked?.error('aborted')
      const found = routed?.asset
      if (!found) {
        tracked?.error(unreachable(this.#url))
        this.#state(4)
        if (!this.#async) throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${this.#url}'.`, 'NetworkError')
        fire(this, new ProgressEvent('error'))
        fire(this, new ProgressEvent('loadend'))
        return
      }
      tracked?.response(200, 'OK', assetHead(found))
      tracked?.received(found.bytes.length, found.bytes)
      tracked?.end(found.bytes.length)
      this.#bytes = found.bytes
      this.#type = found.type
      this.#responseHeaders = assetHead(found)
      this.status = 200
      this.statusText = 'OK'
      this.responseURL = this.#url
      this.#state(2)
      this.#state(3)
      this.#state(4)
      const total = found.bytes.length
      fire(this, new ProgressEvent('load', { lengthComputable: true, loaded: total, total }))
      fire(this, new ProgressEvent('loadend', { lengthComputable: true, loaded: total, total }))
    }
    if (!this.#async) return finish()
    fire(this, new ProgressEvent('loadstart'))
    host.setTimer(0, finish)
  }

  #mocked(mock: MockReply, token: number): void {
    const tracked = Tracked.start('xhr', this.#method, this.#url, 0, true, this.#headers)
    const finish = () => {
      if (token !== this.#sent) return tracked?.error('aborted')
      if ('error' in mock) {
        tracked?.error(mock.error)
        this.#state(4)
        if (!this.#async) throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${this.#url}'.`, 'NetworkError')
        fire(this, new ProgressEvent('error'))
        fire(this, new ProgressEvent('loadend'))
        return
      }
      const body = this.#method === 'HEAD' || NULL_BODY.has(mock.status) ? new Uint8Array(0) : mock.body
      tracked?.response(mock.status, mock.statusText, mock.headers)
      tracked?.received(body.length, body)
      tracked?.end(body.length)
      this.#bytes = body
      this.#responseHeaders = mock.headers.map(([name, value]) => [name, value] as Header)
      this.#type = headerOf(this.#responseHeaders, 'content-type') ?? ''
      this.status = mock.status
      this.statusText = mock.statusText
      this.responseURL = this.#url
      this.#state(2)
      this.#state(3)
      this.#state(4)
      const total = body.length
      fire(this, new ProgressEvent('load', { lengthComputable: true, loaded: total, total }))
      fire(this, new ProgressEvent('loadend', { lengthComputable: true, loaded: total, total }))
    }
    if (!this.#async) return finish()
    fire(this, new ProgressEvent('loadstart'))
    host.setTimer(0, finish)
  }

  #backend(target: Target, token: number, init: BodyInit): void {
    const { bytes, stream, type } = this.#method === 'GET' || this.#method === 'HEAD' ? { bytes: null, stream: null, type: null } : extractBody(init)
    if (type && !this.#headers.has('content-type')) this.#headers.set('content-type', type)
    const live = () => token === this.#sent
    let loaded = 0
    let total = 0
    const finish = (event: 'load' | 'error' | 'timeout', message = 'the request failed'): void => {
      this.#stop = null
      this.#bytes = this.#joined()
      if (event !== 'load') {
        this.status = 0
        this.statusText = ''
        this.#responseHeaders = null
        this.#bytes = null
        if (event === 'error') backendFailed(this.#method, this.#url, message)
      }
      this.#state(4)
      const sizes = { lengthComputable: total > 0, loaded, total }
      fire(this, new ProgressEvent(event, sizes))
      fire(this, new ProgressEvent('loadend', sizes))
    }
    const start = (sent: Uint8Array | null): void => {
      if (!live()) return
      const credentials = this.withCredentials ? 'include' : 'same-origin'
      const request = { url: this.#url, method: this.#method, headers: this.#headers, body: sent, redirect: 'follow' as const, credentials }
      this.#stop = exchange(target, { ...request, mode: 'cors' as const }, {
        head: (head) => {
          if (!live()) return
          this.status = head.status
          this.statusText = head.statusText
          this.responseURL = head.url
          this.#responseHeaders = head.headers
          this.#type = headerOf(head.headers, 'content-type') ?? ''
          total = Number(headerOf(head.headers, 'content-length') ?? 0) || 0
          this.#state(2)
        },
        chunk: (data) => {
          if (!live()) return
          this.#chunks.push(data)
          this.#bytes = null
          loaded += data.length
          this.#state(3)
          fire(this, new ProgressEvent('progress', { lengthComputable: total > 0, loaded, total }))
        },
        end: () => {
          if (live()) finish('load')
        },
        error: (message) => {
          if (live()) finish('error', message)
        },
      }, 'xhr')
      if (this.timeout > 0) {
        host.setTimer(this.timeout, () => {
          if (!live() || this.readyState === 4) return
          this.#stop?.()
          finish('timeout')
        })
      }
    }
    if (stream) readAllBytes(stream).then(start, () => live() && finish('error'))
    else start(bytes)
  }

  #joined(): Uint8Array | null {
    if (this.#bytes) return this.#bytes
    if (!this.#chunks.length) return this.#responseHeaders ? new Uint8Array(0) : null
    if (this.#chunks.length === 1) return (this.#bytes = this.#chunks[0]!)
    const out = concat(this.#chunks)
    this.#chunks = [out]
    return (this.#bytes = out)
  }

  abort(): void {
    this.#sent++
    this.#stop?.()
    this.#stop = null
    if (this.readyState === 0 || this.readyState === 4) return
    this.#state(4)
    fire(this, new ProgressEvent('abort'))
    fire(this, new ProgressEvent('loadend'))
    this.readyState = 0
  }

  get responseText(): string {
    const bytes = this.#joined()
    return bytes ? new TextDecoder().decode(bytes) : ''
  }

  get response(): unknown {
    const text = this.responseType === '' || this.responseType === 'text'
    if (text && this.readyState === 3) return this.responseText
    const bytes = this.readyState === 4 ? this.#joined() : null
    if (!bytes) return text ? '' : null
    switch (this.responseType) {
      case 'json':
        try {
          return JSON.parse(this.responseText)
        } catch {
          return null
        }
      case 'arraybuffer': return bytes.slice().buffer
      case 'blob': return new Blob([bytes], { type: this.#type })
      case 'document': return null
      default: return this.responseText
    }
  }

  getResponseHeader(name: string): string | null {
    if (this.readyState < 2 || !this.#responseHeaders) return null
    return headerOf(this.#responseHeaders, String(name).toLowerCase())
  }

  getAllResponseHeaders(): string {
    if (this.readyState < 2 || !this.#responseHeaders) return ''
    const names = [...new Set(this.#responseHeaders.map(([n]) => n.toLowerCase()))].sort()
    return names.map((n) => `${n}: ${headerOf(this.#responseHeaders!, n)}\r\n`).join('')
  }

  overrideMimeType(type: string): void {
    this.#type = String(type)
  }
}
getters(XMLHttpRequest.prototype, { responseXML: null })
defineHandlers(XMLHttpRequest.prototype, ['readystatechange'])
constants(XMLHttpRequest, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })
tag(XMLHttpRequest)

const WS_STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

export class WebSocket extends EventTarget {
  readonly url: string
  readyState = 0
  protocol = ''
  extensions = ''
  bufferedAmount = 0
  readonly withCredentials = false
  #binaryType: 'blob' | 'arraybuffer' = 'blob'
  #id: number | null = null
  #finished = false
  #tracked: Tracked | null = null
  readonly #origin: string

  constructor(url: string | URL, protocols?: string | Iterable<string>) {
    super()
    let parsed: URL
    try {
      parsed = new URL(String(url), net.base())
    } catch {
      throw new DOMException(`Failed to construct 'WebSocket': The URL '${String(url)}' is invalid.`, 'SyntaxError')
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') parsed = new URL(`ws${parsed.href.slice(4)}`)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      const what = `The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${parsed.protocol}' is not allowed.`
      throw new DOMException(`Failed to construct 'WebSocket': ${what}`, 'SyntaxError')
    }
    if (parsed.hash) {
      const what = `The URL contains a fragment identifier ('${parsed.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`
      throw new DOMException(`Failed to construct 'WebSocket': ${what}`, 'SyntaxError')
    }
    this.url = parsed.href
    this.#origin = parsed.origin
    const list = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : [...protocols].map(String)
    if (new Set(list).size !== list.length) throw new DOMException("Failed to construct 'WebSocket': The subprotocol is duplicated.", 'SyntaxError')
    this.#tracked = Tracked.start('websocket', 'GET', this.url)
    const routed = route(this.url, 'WS')
    if (!routed || !('target' in routed)) {
      this.#tracked?.error(unreachable(this.url))
      host.setTimer(0, () => this.#finish(1006, '', false))
      return
    }
    this.#connect(routed.target, list)
  }

  #connect(target: Target, protocols: string[]): void {
    const headers = isRemote(target)
      ? browserHeaders([['origin', new URL(net.base()).origin]], false)
      : requestHeaders([], target, { origin: true, cookies: true })
    const onEvent = (event: WsEvent): void => {
      if (this.#finished) return
      switch (event.type) {
        case 'open':
          if (this.readyState !== WS_STATES.CONNECTING) return
          this.readyState = WS_STATES.OPEN
          this.protocol = event.protocol ?? ''
          this.extensions = event.extensions ?? ''
          this.#tracked?.response(101, 'Switching Protocols')
          fire(this, new Event('open'))
          return
        case 'message': {
          if (this.readyState !== WS_STATES.OPEN) return
          this.#tracked?.received(event.text !== undefined ? event.text.length : (event.data?.length ?? 0))
          let data: unknown
          if (event.text !== undefined) data = event.text
          else {
            const bytes = event.data ?? new Uint8Array(0)
            data = this.#binaryType === 'arraybuffer' ? bytes.slice().buffer : new Blob([bytes])
          }
          fire(this, new MessageEvent('message', { data, origin: this.#origin }))
          return
        }
        case 'close':
          return this.#finish(event.code ?? 1005, event.reason ?? '', !!event.wasClean)
        case 'error':
          backendFailed('WS', this.url, event.message)
          this.#tracked?.error(event.message)
          return this.#finish(1006, '', false)
      }
    }
    try {
      const [to, path] = dialOf(target)
      this.#id = transport!.websocket(to, path, headers, protocols, onEvent)
    } catch (error) {
      backendFailed('WS', this.url, String((error as Error)?.message ?? error))
      this.#tracked?.error(String((error as Error)?.message ?? error))
      host.queueMicrotask(() => this.#finish(1006, '', false))
    }
  }

  #finish(code: number, reason: string, wasClean: boolean): void {
    if (this.#finished) return
    this.#finished = true
    if (wasClean) this.#tracked?.end()
    else this.#tracked?.error(`closed ${code}${reason ? ` ${reason}` : ''}`)
    this.readyState = WS_STATES.CLOSED
    if (!wasClean) fire(this, new Event('error'))
    fire(this, new CloseEvent('close', { code, reason, wasClean }))
  }

  get binaryType(): 'blob' | 'arraybuffer' {
    return this.#binaryType
  }
  set binaryType(value: string) {
    if (value === 'blob' || value === 'arraybuffer') this.#binaryType = value
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState === WS_STATES.CONNECTING) {
      throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError')
    }
    let payload: string | Uint8Array
    if (typeof data === 'string') payload = data
    else if (data instanceof Blob) payload = blobBytes(data).slice()
    else if (typeof data === 'object' && data !== null) payload = bytesOf(data as ArrayBuffer).slice()
    else payload = String(data)
    if (this.readyState !== WS_STATES.OPEN || this.#id === null) {
      this.bufferedAmount += typeof payload === 'string' ? host.encodeUtf8(payload).length : payload.length
      return
    }
    transport?.send(this.#id, payload)
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined) {
      code = Number(code)
      if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
        const what = `The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`
        throw new DOMException(`Failed to execute 'close' on 'WebSocket': ${what}`, 'InvalidAccessError')
      }
    }
    if (reason !== undefined && host.encodeUtf8(String(reason)).length > 123) {
      throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError')
    }
    if (this.readyState === WS_STATES.CLOSING || this.readyState === WS_STATES.CLOSED) return
    if (this.#id === null) {
      this.readyState = WS_STATES.CLOSED
      return
    }
    this.readyState = WS_STATES.CLOSING
    transport?.close(this.#id, code, reason === undefined ? undefined : String(reason))
  }
}
constants(WebSocket, WS_STATES)
defineHandlers(WebSocket.prototype, ['open', 'message', 'error', 'close'])
tag(WebSocket)

const ES_STATES = { CONNECTING: 0, OPEN: 1, CLOSED: 2 } as const

export class EventSource extends EventTarget {
  readonly url: string
  readonly withCredentials: boolean
  readyState = 0
  #target: Target | null = null
  #lastId = ''
  #retry = 3000
  #stop: (() => void) | null = null
  #timer = 0

  constructor(url: string | URL, init?: { withCredentials?: boolean }) {
    super()
    try {
      this.url = new URL(String(url), net.base()).href
    } catch {
      throw new DOMException(`Failed to construct 'EventSource': Cannot open an EventSource to '${String(url)}'. The URL is invalid.`, 'SyntaxError')
    }
    this.withCredentials = !!init?.withCredentials
    const routed = route(this.url, 'SSE')
    if (!routed || !('target' in routed)) {
      host.setTimer(0, () => {
        this.readyState = ES_STATES.CLOSED
        fire(this, new Event('error'))
      })
      return
    }
    this.#target = routed.target
    this.#connect()
  }

  #connect(): void {
    const decoder = new TextDecoder()
    const origin = new URL(this.url).origin
    let buffer = ''
    let started = false
    let data = ''
    let type = ''
    let id = this.#lastId
    const dispatch = (): void => {
      this.#lastId = id
      if (!data) {
        type = ''
        return
      }
      const event = new MessageEvent(type || 'message', { data: data.endsWith('\n') ? data.slice(0, -1) : data, origin, lastEventId: this.#lastId })
      data = ''
      type = ''
      if (this.readyState !== ES_STATES.CLOSED) fire(this, event)
    }
    const line = (text: string): void => {
      if (!text) return dispatch()
      if (text.startsWith(':')) return
      const colon = text.indexOf(':')
      const field = colon < 0 ? text : text.slice(0, colon)
      let value = colon < 0 ? '' : text.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') type = value
      else if (field === 'data') data += `${value}\n`
      else if (field === 'id') {
        if (!value.includes('\0')) id = value
      } else if (field === 'retry' && /^\d+$/.test(value)) this.#retry = Number(value)
    }
    const feed = (text: string, end: boolean): void => {
      if (!started && text) {
        started = true
        if (text.startsWith('\uFEFF')) text = text.slice(1)
      }
      buffer += text
      let at = 0
      for (;;) {
        const cr = buffer.indexOf('\r', at)
        const lf = buffer.indexOf('\n', at)
        const stop = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf)
        if (stop < 0) break
        if (stop === cr && cr === buffer.length - 1 && !end) break
        line(buffer.slice(at, stop))
        at = stop + (stop === cr && buffer[cr + 1] === '\n' ? 2 : 1)
        if (this.readyState === ES_STATES.CLOSED) return
      }
      buffer = buffer.slice(at)
    }
    const headers: [string, string][] = [['accept', 'text/event-stream'], ['cache-control', 'no-cache']]
    if (this.#lastId) headers.push(['last-event-id', this.#lastId])
    const credentials = this.withCredentials ? 'include' : 'same-origin'
    this.#stop = exchange(this.#target!, { url: this.url, method: 'GET', headers, body: null, redirect: 'follow', credentials, mode: 'cors' }, {
      head: (head) => {
        if (this.readyState === ES_STATES.CLOSED) return
        const contentType = headerOf(head.headers, 'content-type') ?? ''
        if (head.status !== 200 || !/^text\/event-stream\s*(;|$)/i.test(contentType)) {
          backendFailed('SSE', this.url, `status ${head.status}, ${contentType || 'no content type'}`)
          return this.#fail()
        }
        this.readyState = ES_STATES.OPEN
        fire(this, new Event('open'))
      },
      chunk: (bytes) => {
        if (this.readyState === ES_STATES.OPEN) feed(decoder.decode(bytes, { stream: true }), false)
      },
      end: () => {
        if (this.readyState === ES_STATES.OPEN) feed(decoder.decode(), true)
        this.#reconnect()
      },
      error: (message) => {
        backendFailed('SSE', this.url, message)
        this.#reconnect()
      },
    }, 'eventsource')
  }

  #reconnect(): void {
    this.#stop = null
    if (this.readyState === ES_STATES.CLOSED) return
    this.readyState = ES_STATES.CONNECTING
    fire(this, new Event('error'))
    if (this.readyState === ES_STATES.CLOSED) return
    this.#timer = host.setTimer(this.#retry, () => {
      this.#timer = 0
      if (this.readyState === ES_STATES.CONNECTING) this.#connect()
    })
  }

  #fail(): void {
    this.#stop?.()
    this.#stop = null
    this.readyState = ES_STATES.CLOSED
    fire(this, new Event('error'))
  }

  close(): void {
    this.readyState = ES_STATES.CLOSED
    this.#stop?.()
    this.#stop = null
    if (this.#timer) host.clearTimer(this.#timer)
    this.#timer = 0
  }
}
constants(EventSource, ES_STATES)
defineHandlers(EventSource.prototype, ['open', 'message', 'error'])
tag(EventSource)
