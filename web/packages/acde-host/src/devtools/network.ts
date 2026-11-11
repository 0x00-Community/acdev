import type { NetworkHeaders, NetworkObserver, RequestKind } from '@dopame/acde-dom'
import { DevToolsError, type DevToolsDomain, type DevToolsPage } from './index'

const TYPES: Partial<Record<RequestKind, string>> = { fetch: 'Fetch', xhr: 'XHR' }
const TEXT = /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded)|image\/svg\+xml)|\+json$|\+xml$/i

interface Open {
  readonly type: string
  readonly url: string
  mimeType: string
  chunks: Uint8Array[]
  size: number
}

interface Kept {
  readonly body: Uint8Array
  readonly mimeType: string
}

export class NetworkDomain {
  static readonly BODIES = 16 << 20

  readonly #open = new Map<number, Open>()
  readonly #bodies = new Map<string, Kept>()
  #kept = 0

  constructor(
    readonly page: DevToolsPage,
    readonly documentUrl: () => string,
    readonly limit = NetworkDomain.BODIES,
    readonly clock: () => number = () => performance.now() / 1000,
  ) {}

  readonly observer: NetworkObserver = {
    recording: () => this.page.listening('Network'),
    start: (id, kind, method, url, headers, body) => this.#start(id, kind, method, url, headers, body),
    response: (id, status, statusText, headers) => this.#response(id, status, statusText, headers),
    data: (id, chunk) => this.#data(id, chunk),
    end: (id, bytes) => this.#end(id, bytes),
    error: (id, message) => this.#error(id, message),
  }

  domain(): DevToolsDomain {
    return {
      name: 'Network',
      methods: {
        getResponseBody: (params) => this.#body(String(params['requestId'] ?? '')),
      },
    }
  }

  static headers(list: NetworkHeaders): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of list) out[name] = name in out ? `${out[name]}\n${value}` : value
    return out
  }

  static mimeType(list: NetworkHeaders): string {
    const type = list.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
    return type.split(';')[0]!.trim().toLowerCase()
  }

  #emit(method: string, params: Record<string, unknown>): void {
    this.page.emit('Network', method, params)
  }

  #start(id: number, kind: RequestKind, method: string, url: string, headers: NetworkHeaders, body: Uint8Array | null): void {
    const type = TYPES[kind]
    if (!type) return
    this.#open.set(id, { type, url, mimeType: '', chunks: [], size: 0 })
    const request: Record<string, unknown> = {
      url,
      method,
      headers: NetworkDomain.headers(headers),
      initialPriority: 'High',
      referrerPolicy: 'strict-origin-when-cross-origin',
    }
    if (body?.length) {
      request['hasPostData'] = true
      request['postData'] = new TextDecoder().decode(body)
    }
    this.#emit('requestWillBeSent', {
      requestId: String(id),
      loaderId: this.page.frameId,
      documentURL: this.documentUrl(),
      request,
      timestamp: this.clock(),
      wallTime: Date.now() / 1000,
      initiator: { type: 'script' },
      redirectHasExtraInfo: false,
      type,
      frameId: this.page.frameId,
    })
  }

  #response(id: number, status: number, statusText: string, headers: NetworkHeaders): void {
    const open = this.#open.get(id)
    if (!open) return
    open.mimeType = NetworkDomain.mimeType(headers)
    this.#emit('responseReceived', {
      requestId: String(id),
      loaderId: this.page.frameId,
      timestamp: this.clock(),
      type: open.type,
      frameId: this.page.frameId,
      hasExtraInfo: false,
      response: {
        url: open.url,
        status,
        statusText,
        headers: NetworkDomain.headers(headers),
        mimeType: open.mimeType,
        charset: '',
        connectionReused: false,
        connectionId: 0,
        encodedDataLength: 0,
        securityState: 'neutral',
      },
    })
  }

  #data(id: number, chunk: Uint8Array): void {
    const open = this.#open.get(id)
    if (!open) return
    if (open.size + chunk.length <= this.limit) open.chunks.push(chunk.slice())
    open.size += chunk.length
    this.#emit('dataReceived', { requestId: String(id), timestamp: this.clock(), dataLength: chunk.length, encodedDataLength: chunk.length })
  }

  #end(id: number, bytes: number): void {
    const open = this.#open.get(id)
    if (!open) return
    this.#open.delete(id)
    if (open.size <= this.limit) this.#keep(String(id), open)
    this.#emit('loadingFinished', { requestId: String(id), timestamp: this.clock(), encodedDataLength: bytes })
  }

  #error(id: number, message: string): void {
    const open = this.#open.get(id)
    if (!open) return
    this.#open.delete(id)
    const failed: Record<string, unknown> = { requestId: String(id), timestamp: this.clock(), type: open.type, errorText: message }
    if (message === 'aborted') failed['canceled'] = true
    this.#emit('loadingFailed', failed)
  }

  #keep(id: string, open: Open): void {
    const body = new Uint8Array(open.size)
    let at = 0
    for (const chunk of open.chunks) {
      body.set(chunk, at)
      at += chunk.length
    }
    this.#bodies.set(id, { body, mimeType: open.mimeType })
    this.#kept += body.length
    for (const [oldest, kept] of this.#bodies) {
      if (this.#kept <= this.limit) break
      this.#bodies.delete(oldest)
      this.#kept -= kept.body.length
    }
  }

  #body(id: string): { body: string; base64Encoded: boolean } {
    const kept = this.#bodies.get(id)
    if (!kept) throw new DevToolsError(-32000, 'No resource with given identifier found')
    if (TEXT.test(kept.mimeType) || kept.mimeType === '') {
      try {
        return { body: new TextDecoder('utf-8', { fatal: true }).decode(kept.body), base64Encoded: false }
      } catch {}
    }
    let binary = ''
    for (let at = 0; at < kept.body.length; at += 0x8000) binary += String.fromCharCode(...kept.body.subarray(at, at + 0x8000))
    return { body: btoa(binary), base64Encoded: true }
  }
}
