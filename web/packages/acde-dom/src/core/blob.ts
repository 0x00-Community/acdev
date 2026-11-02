import { defineHandlers, Event, EventTarget, fire, ProgressEvent } from './event'
import { DOMException } from './exception'
import { base64, bytesOf, concat, latin1, TextDecoder } from './encoding'
import { host, tag } from './host'
import { streamOfBytes, type ReadableStream } from './streams'

type BlobPart = Blob | ArrayBuffer | ArrayBufferView | string

let blobBytes: (blob: Blob) => Uint8Array

export class Blob {
  #bytes: Uint8Array
  #type: string

  constructor(parts: Iterable<BlobPart> = [], options?: { type?: string; endings?: string }) {
    const chunks: Uint8Array[] = []
    for (const part of parts) chunks.push(part instanceof Blob ? part.#bytes : typeof part === 'string' ? host.encodeUtf8(part) : typeof part === "object" && part !== null ? bytesOf(part) : host.encodeUtf8(String(part)))
    this.#bytes = concat(chunks)
    const type = String(options?.type ?? '')
    this.#type = /^[\x20-\x7e]*$/.test(type) ? type.toLowerCase() : ''
  }

  static {
    blobBytes = (blob) => blob.#bytes
  }

  get size(): number {
    return this.#bytes.length
  }

  get type(): string {
    return this.#type
  }

  slice(start = 0, end = this.#bytes.length, type = ''): Blob {
    const size = this.#bytes.length
    const from = start < 0 ? Math.max(size + start, 0) : Math.min(start, size)
    const to = end < 0 ? Math.max(size + end, 0) : Math.min(end, size)
    return new Blob([this.#bytes.subarray(from, Math.max(from, to))], { type })
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.#bytes)
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer
  }

  async bytes(): Promise<Uint8Array> {
    return this.#bytes.slice()
  }

  stream(): ReadableStream<Uint8Array> {
    return streamOfBytes(this.#bytes.slice())
  }
}
tag(Blob)

export function bytesOfBlob(blob: Blob): Uint8Array {
  return blobBytes(blob)
}

export class File extends Blob {
  readonly #name: string
  readonly #lastModified: number

  constructor(parts: Iterable<BlobPart>, name: string, options?: { type?: string; lastModified?: number }) {
    super(parts, options)
    this.#name = String(name)
    this.#lastModified = options?.lastModified ?? Date.now()
  }

  get name(): string {
    return this.#name
  }

  get lastModified(): number {
    return this.#lastModified
  }

  get webkitRelativePath(): string {
    return ''
  }
}
tag(File)

export class FileReader extends EventTarget {
  static readonly EMPTY = 0
  static readonly LOADING = 1
  static readonly DONE = 2
  readyState = 0
  result: string | ArrayBuffer | null = null
  error: DOMException | null = null
  #token = 0

  #read(blob: Blob, as: (bytes: Uint8Array) => string | ArrayBuffer): void {
    if (this.readyState === 1) throw new DOMException('The object is already busy reading Blobs.', 'InvalidStateError')
    if (!(blob instanceof Blob)) throw new TypeError("Failed to execute 'read' on 'FileReader': parameter 1 is not of type 'Blob'.")
    this.readyState = 1
    this.result = null
    const token = ++this.#token
    const bytes = blobBytes(blob)
    host.queueMicrotask(() => {
      if (token !== this.#token) return
      fire(this, new ProgressEvent('loadstart', { lengthComputable: true, loaded: 0, total: bytes.length }))
      this.result = as(bytes)
      this.readyState = 2
      fire(this, new ProgressEvent('load', { lengthComputable: true, loaded: bytes.length, total: bytes.length }))
      fire(this, new ProgressEvent('loadend', { lengthComputable: true, loaded: bytes.length, total: bytes.length }))
    })
  }

  readAsText(blob: Blob, encoding = 'utf-8'): void {
    this.#read(blob, (bytes) => new TextDecoder(encoding).decode(bytes))
  }

  readAsDataURL(blob: Blob): void {
    this.#read(blob, (bytes) => `data:${blob.type || 'application/octet-stream'};base64,${base64(bytes)}`)
  }

  readAsArrayBuffer(blob: Blob): void {
    this.#read(blob, (bytes) => bytes.slice().buffer)
  }

  readAsBinaryString(blob: Blob): void {
    this.#read(blob, latin1)
  }

  abort(): void {
    if (this.readyState !== 1) return
    this.#token++
    this.readyState = 2
    this.result = null
    fire(this, new Event('abort'))
    fire(this, new Event('loadend'))
  }
}
defineHandlers(FileReader.prototype, ['loadstart', 'progress', 'load', 'abort', 'error', 'loadend'])
tag(FileReader)
