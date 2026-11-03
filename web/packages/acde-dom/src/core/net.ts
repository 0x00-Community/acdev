import { Blob, blobBytes } from './blob'
import { backendTarget, cookies, requestHeaders, type BackendTarget, type Header, type HttpEvent, type WsEvent, transport } from './backend'
import { bytesOf, concat, TextDecoder, unbase64 } from './encoding'
import { CloseEvent, defineHandlers, Event, EventTarget, fire, MessageEvent, ProgressEvent } from './event'
import { DOMException } from './exception'
import { G, host, tag } from './host'
import { isDisturbed, readAllBytes, ReadableStream, streamOfBytes, type ReadableStreamDefaultController } from './streams'
import { objectUrls, URL, URLSearchParams } from './url'

export const net = {
  base: () => 'http://acde.local/',
  misses: new Map<string, number>(),
  log: true,
}

const TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function typeOfName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  return TYPES[ext] ?? ''
}

function routeKey(method: string, url: string): string {
  try {
    return `${method} ${new URL(url).pathname}`
  } catch {
    return `${method} ${url}`
  }
}

function miss(method: string, url: string): void {
  const key = routeKey(method, url)
  const seen = net.misses.get(key) ?? 0
  net.misses.set(key, seen + 1)
  if (seen === 0 && net.log) host.print(1, `acde-dom: ${key}: no network; refused`)
}

const failures = new Set<string>()

function backendFailed(method: string, url: string, message: string): void {
  const key = routeKey(method, url)
  if (failures.has(key) || !net.log) return
  failures.add(key)
  host.print(1, `acde-dom: ${key}: the app's backend: ${message}`)
}

type Loaded = { bytes: Uint8Array; type: string }

function asset(url: URL): Loaded | null {
  const bytes = host.readAsset(url.href)
  return bytes && { bytes, type: typeOfName(url.pathname) || 'application/octet-stream' }
}

function load(url: string, method: string): Loaded | null {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma < 0) return null
    const meta = url.slice(5, comma)
    const body = url.slice(comma + 1)
    const base64 = /;base64$/i.test(meta)
    const bytes = base64 ? unbase64(decodeURIComponent(body)) : host.encodeUtf8(decodeURIComponent(body))
    return bytes ? { bytes, type: meta.replace(/;base64$/i, '') || 'text/plain;charset=US-ASCII' } : null
  }
  if (url.startsWith('blob:')) {
    const blob = objectUrls.get(url)
    return blob instanceof Blob ? { bytes: blobBytes(blob), type: blob.type } : null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const own = new URL(net.base())
  if (parsed.origin !== own.origin || (method !== 'GET' && method !== 'HEAD')) {
    miss(method, url)
    return null
  }
  const found = asset(parsed)
  if (!found) miss(method, url)
  return found
}

function backendRoute(url: string, method: string, connection = false): { target: BackendTarget } | { asset: Loaded } | null {
  if (!transport || url.startsWith('data:') || url.startsWith('blob:')) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const own = new URL(net.base())
  const target = backendTarget(parsed, own)
  if (!target) return null
  if (!connection && parsed.origin === own.origin && (method === 'GET' || method === 'HEAD')) {
    const found = asset(parsed)
    if (found) return { asset: found }
  }
  return { target }
}

type HeadersInit = Headers | Record<string, string> | Iterable<readonly [string, string]>

export class Headers {
  #map = new Map<string, string>()
  #cookies: string[] = []

  constructor(init?: HeadersInit | null) {
    if (!init) return
    if (init instanceof Headers) for (const [k, v] of init) this.append(k, v)
    else if (typeof (init as Iterable<unknown>)[Symbol.iterator] === 'function') for (const [k, v] of init as Iterable<readonly [string, string]>) this.append(k, v)
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

function headerOf(headers: readonly Header[], name: string): string | null {
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
    this.#used = true
    if (this.#stream) {
      if (this.#stream.locked) throw new TypeError('Failed to execute: body stream is locked')
      return readAllBytes(this.#stream)
    }
    return this.#bytes ?? new Uint8Array(0)
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
  readonly mode = 'cors'
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
    this.url = base ? base.url : new URL(String(input), net.base()).href
    this.method = String(init?.method ?? base?.method ?? 'GET').toUpperCase()
    this.headers = new Headers(init?.headers ?? base?.headers)
    if (type && !this.headers.has('content-type')) this.headers.set('content-type', type)
    this.signal = init?.signal ?? base?.signal ?? null
    this.cache = init?.cache ?? 'default'
    this.credentials = init?.credentials ?? base?.credentials ?? 'same-origin'
    this.redirect = init?.redirect ?? base?.redirect ?? 'follow'
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
    if (this.status < 200 || this.status > 599) throw new RangeError(`Failed to construct 'Response': The status provided (${this.status}) is outside the range [200, 599].`)
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
    const copy = new Response(stream ?? bytes, { status: this.status, statusText: this.statusText, headers: this.headers })
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
}

function exchange(first: BackendTarget, request: ExchangeRequest, on: ExchangeHandlers): () => void {
  const backend = transport!
  const withCookies = request.credentials !== 'omit'
  let current: Promise<number> | null = null
  let finished = false
  let redirects = 0
  const fail = (message: string): void => {
    if (finished) return
    finished = true
    on.error(message)
  }
  const stop = (id: Promise<number> | null): void => {
    id?.then((n) => backend.abort(n)).catch(() => undefined)
  }
  const send = (target: BackendTarget, url: string, method: string, pageHeaders: Iterable<readonly [string, string]>, body: Uint8Array | null): void => {
    const headers = requestHeaders(pageHeaders, target, { origin: method !== 'GET' && method !== 'HEAD', cookies: withCookies })
    if (!headers.some(([n]) => n.toLowerCase() === 'accept')) headers.push(['accept', '*/*'])
    const onEvent = (event: HttpEvent): void => {
      if (finished || current !== mine) return
      switch (event.type) {
        case 'head': {
          const all = event.headers ?? []
          if (withCookies) for (const [name, value] of all) if (name.toLowerCase() === 'set-cookie') cookies.store(value, target.path)
          const location = headerOf(all, 'location')
          if (!REDIRECTS.has(event.status) || location === null || request.redirect === 'manual') {
            on.head({ status: event.status, statusText: event.statusText ?? '', headers: visibleHeaders(all), url, redirected: redirects > 0 })
            return
          }
          stop(mine)
          current = null
          if (request.redirect === 'error') return fail(`redirected to ${location}`)
          if (++redirects > 20) return fail('too many redirects')
          let next: string
          try {
            next = new URL(location, url).href
          } catch {
            return fail(`redirected to an invalid URL ${location}`)
          }
          const toGet = (event.status === 303 && method !== 'HEAD') || ((event.status === 301 || event.status === 302) && method === 'POST')
          const nextMethod = toGet ? 'GET' : method
          const nextHeaders = toGet ? [...pageHeaders].filter(([n]) => !BODY_HEADERS.has(n.toLowerCase())) : pageHeaders
          const routed = backendRoute(next, nextMethod)
          if (routed && 'target' in routed) return send(routed.target, next, nextMethod, nextHeaders, toGet ? null : body)
          const found = routed ? routed.asset : load(next, nextMethod)
          if (!found) return fail(`redirected to ${next}, which is not the app's`)
          finished = true
          on.head({ status: 200, statusText: 'OK', headers: [['content-length', String(found.bytes.length)], ['content-type', found.type]], url: next, redirected: true })
          if (nextMethod !== 'HEAD') on.chunk(found.bytes)
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
    const mine: Promise<number> = Promise.resolve().then(() => backend.request(target.port, method, target.path, headers, body, onEvent))
    current = mine
    mine.catch((error: unknown) => {
      if (current === mine) fail(String((error as Error)?.message ?? error))
    })
  }
  send(first, request.url, request.method, request.headers, request.body)
  return () => {
    if (finished) return
    finished = true
    stop(current)
  }
}

type SignalLike = { aborted?: boolean; reason?: unknown; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void }

function aborted(signal: SignalLike): unknown {
  return signal.reason ?? new DOMException('The user aborted a request.', 'AbortError')
}

function assetResponse(request: Request, found: Loaded): Response {
  const response = new Response(request.method === 'HEAD' ? null : found.bytes, { status: 200, statusText: 'OK', headers: { 'content-type': found.type, 'content-length': String(found.bytes.length) } })
  response.url = request.url
  return response
}

async function fetchBackend(request: Request, target: BackendTarget, signal: SignalLike | null): Promise<Response> {
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request[SEND]()
  if (signal?.aborted) throw aborted(signal)
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let response: Response | null = null
    const settle = (): void => signal?.removeEventListener?.('abort', onAbort)
    const abort = exchange(target, { url: request.url, method: request.method, headers: request.headers, body, redirect: request.redirect, credentials: request.credentials }, {
      head(head) {
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
    })
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

export function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let request: Request
  try {
    request = new Request(input, init)
  } catch (error) {
    return Promise.reject(error instanceof TypeError ? error : new TypeError(String((error as Error)?.message ?? error)))
  }
  const signal = request.signal as SignalLike | null
  if (signal?.aborted) return Promise.reject(aborted(signal))
  const routed = backendRoute(request.url, request.method)
  if (routed && 'target' in routed) return fetchBackend(request, routed.target, signal)
  return new Promise((resolve, reject) => {
    host.setTimer(0, () => {
      if (signal?.aborted) return reject(aborted(signal))
      const found = routed ? routed.asset : load(request.url, request.method)
      if (!found) return reject(new TypeError('Failed to fetch'))
      resolve(assetResponse(request, found))
    })
  })
}

export class XMLHttpRequestEventTarget extends EventTarget {}
defineHandlers(XMLHttpRequestEventTarget.prototype, ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'])
tag(XMLHttpRequestEventTarget)

export class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
tag(XMLHttpRequestUpload)

export class XMLHttpRequest extends XMLHttpRequestEventTarget {
  static readonly UNSENT = 0
  static readonly OPENED = 1
  static readonly HEADERS_RECEIVED = 2
  static readonly LOADING = 3
  static readonly DONE = 4
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
    if (this.readyState !== 1) throw new DOMException("Failed to execute 'setRequestHeader' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError')
    this.#headers.append(name, value)
  }

  #state(state: number): void {
    this.readyState = state
    fire(this, new Event('readystatechange'))
  }

  send(body?: BodyInit): void {
    if (this.readyState !== 1) throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.", 'InvalidStateError')
    const token = ++this.#sent
    const routed = backendRoute(this.#url, this.#method)
    if (routed && 'target' in routed) {
      if (!this.#async) throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': synchronous requests to the app's backend are not supported ('${this.#url}').`, 'NetworkError')
      fire(this, new ProgressEvent('loadstart'))
      return this.#backend(routed.target, token, body)
    }
    const finish = () => {
      if (token !== this.#sent) return
      const found = routed ? routed.asset : load(this.#url, this.#method)
      if (!found) {
        this.#state(4)
        if (!this.#async) throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${this.#url}'.`, 'NetworkError')
        fire(this, new ProgressEvent('error'))
        fire(this, new ProgressEvent('loadend'))
        return
      }
      this.#bytes = found.bytes
      this.#type = found.type
      this.#responseHeaders = [['content-length', String(found.bytes.length)], ['content-type', found.type]]
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

  #backend(target: BackendTarget, token: number, init: BodyInit): void {
    const { bytes, stream, type } = this.#method === 'GET' || this.#method === 'HEAD' ? { bytes: null, stream: null, type: null } : extractBody(init)
    if (type && !this.#headers.has('content-type')) this.#headers.set('content-type', type)
    const live = () => token === this.#sent
    let loaded = 0
    let total = 0
    const finish = (event: 'load' | 'error' | 'timeout'): void => {
      this.#stop = null
      this.#bytes = this.#joined()
      if (event !== 'load') {
        this.status = 0
        this.statusText = ''
        this.#responseHeaders = null
        this.#bytes = null
        if (event === 'error') backendFailed(this.#method, this.#url, 'the request failed')
      }
      this.#state(4)
      const sizes = { lengthComputable: total > 0, loaded, total }
      fire(this, new ProgressEvent(event, sizes))
      fire(this, new ProgressEvent('loadend', sizes))
    }
    const start = (sent: Uint8Array | null): void => {
      if (!live()) return
      this.#stop = exchange(target, { url: this.#url, method: this.#method, headers: this.#headers, body: sent, redirect: 'follow', credentials: 'include' }, {
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
        error: () => {
          if (live()) finish('error')
        },
      })
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

  get responseXML(): null {
    return null
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
defineHandlers(XMLHttpRequest.prototype, ['readystatechange'])
tag(XMLHttpRequest)

const WS_STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

export class WebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly url: string
  readyState = 0
  protocol = ''
  extensions = ''
  bufferedAmount = 0
  readonly withCredentials = false
  #binaryType: 'blob' | 'arraybuffer' = 'blob'
  #id: Promise<number> | null = null
  #finished = false
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
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new DOMException(`Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${parsed.protocol}' is not allowed.`, 'SyntaxError')
    if (parsed.hash) throw new DOMException(`Failed to construct 'WebSocket': The URL contains a fragment identifier ('${parsed.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`, 'SyntaxError')
    this.url = parsed.href
    this.#origin = parsed.origin
    const list = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : [...protocols].map(String)
    if (new Set(list).size !== list.length) throw new DOMException("Failed to construct 'WebSocket': The subprotocol is duplicated.", 'SyntaxError')
    const routed = backendRoute(this.url, 'GET', true)
    if (!routed || !('target' in routed)) {
      miss('WS', this.url)
      host.setTimer(0, () => this.#finish(1006, '', false))
      return
    }
    this.#connect(routed.target, list)
  }

  #connect(target: BackendTarget, protocols: string[]): void {
    const backend = transport!
      const headers = requestHeaders([], target, { origin: true, cookies: true })
    const onEvent = (event: WsEvent): void => {
      if (this.#finished) return
      switch (event.type) {
        case 'open':
          if (this.readyState !== WS_STATES.CONNECTING) return
          this.readyState = WS_STATES.OPEN
          this.protocol = event.protocol ?? ''
          this.extensions = event.extensions ?? ''
          fire(this, new Event('open'))
          return
        case 'message': {
          if (this.readyState !== WS_STATES.OPEN) return
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
          return this.#finish(1006, '', false)
      }
    }
    this.#id = Promise.resolve().then(() => backend.websocket(target.port, target.path, headers, protocols, onEvent))
    this.#id.catch((error: unknown) => {
      backendFailed('WS', this.url, String((error as Error)?.message ?? error))
      this.#finish(1006, '', false)
    })
  }

  #finish(code: number, reason: string, wasClean: boolean): void {
    if (this.#finished) return
    this.#finished = true
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
    if (this.readyState === WS_STATES.CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError')
    let payload: string | Uint8Array
    if (typeof data === 'string') payload = data
    else if (data instanceof Blob) payload = blobBytes(data).slice()
    else if (typeof data === 'object' && data !== null) payload = bytesOf(data as ArrayBuffer).slice()
    else payload = String(data)
    if (this.readyState !== WS_STATES.OPEN || !this.#id) {
      this.bufferedAmount += typeof payload === 'string' ? host.encodeUtf8(payload).length : payload.length
      return
    }
    this.#id.then((id) => transport?.send(id, payload)).catch(() => undefined)
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined) {
      code = Number(code)
      if (code !== 1000 && !(code >= 3000 && code <= 4999)) throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, 'InvalidAccessError')
    }
    if (reason !== undefined && host.encodeUtf8(String(reason)).length > 123) throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError')
    if (this.readyState === WS_STATES.CLOSING || this.readyState === WS_STATES.CLOSED) return
    if (!this.#id) {
      this.readyState = WS_STATES.CLOSED
      return
    }
    this.readyState = WS_STATES.CLOSING
    this.#id.then((id) => transport?.close(id, code, reason === undefined ? undefined : String(reason))).catch(() => undefined)
  }
}
Object.defineProperties(WebSocket.prototype, Object.fromEntries(Object.entries(WS_STATES).map(([k, v]) => [k, { value: v, enumerable: true }])))
defineHandlers(WebSocket.prototype, ['open', 'message', 'error', 'close'])
tag(WebSocket)

export class EventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly url: string
  readonly withCredentials: boolean
  readyState = 0
  #target: BackendTarget | null = null
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
    const routed = backendRoute(this.url, 'GET', true)
    if (!routed || !('target' in routed)) {
      miss('SSE', this.url)
      host.setTimer(0, () => {
        this.readyState = EventSource.CLOSED
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
      if (this.readyState !== EventSource.CLOSED) fire(this, event)
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
        if (this.readyState === EventSource.CLOSED) return
      }
      buffer = buffer.slice(at)
    }
    const headers: [string, string][] = [['accept', 'text/event-stream'], ['cache-control', 'no-cache']]
    if (this.#lastId) headers.push(['last-event-id', this.#lastId])
    this.#stop = exchange(this.#target!, { url: this.url, method: 'GET', headers, body: null, redirect: 'follow', credentials: this.withCredentials ? 'include' : 'same-origin' }, {
      head: (head) => {
        if (this.readyState === EventSource.CLOSED) return
        const contentType = headerOf(head.headers, 'content-type') ?? ''
        if (head.status !== 200 || !/^text\/event-stream\s*(;|$)/i.test(contentType)) {
          backendFailed('SSE', this.url, `status ${head.status}, ${contentType || 'no content type'}`)
          return this.#fail()
        }
        this.readyState = EventSource.OPEN
        fire(this, new Event('open'))
      },
      chunk: (bytes) => {
        if (this.readyState === EventSource.OPEN) feed(decoder.decode(bytes, { stream: true }), false)
      },
      end: () => {
        if (this.readyState === EventSource.OPEN) feed(decoder.decode(), true)
        this.#reconnect()
      },
      error: (message) => {
        backendFailed('SSE', this.url, message)
        this.#reconnect()
      },
    })
  }

  #reconnect(): void {
    this.#stop = null
    if (this.readyState === EventSource.CLOSED) return
    this.readyState = EventSource.CONNECTING
    fire(this, new Event('error'))
    if (this.readyState === EventSource.CLOSED) return
    this.#timer = host.setTimer(this.#retry, () => {
      this.#timer = 0
      if (this.readyState === EventSource.CONNECTING) this.#connect()
    })
  }

  #fail(): void {
    this.#stop?.()
    this.#stop = null
    this.readyState = EventSource.CLOSED
    fire(this, new Event('error'))
  }

  close(): void {
    this.readyState = EventSource.CLOSED
    this.#stop?.()
    this.#stop = null
    if (this.#timer) host.clearTimer(this.#timer)
    this.#timer = 0
  }
}
Object.defineProperties(EventSource.prototype, { CONNECTING: { value: 0, enumerable: true }, OPEN: { value: 1, enumerable: true }, CLOSED: { value: 2, enumerable: true } })
defineHandlers(EventSource.prototype, ['open', 'message', 'error'])
tag(EventSource)
