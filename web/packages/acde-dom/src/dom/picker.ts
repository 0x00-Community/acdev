import { Blob, File } from '../core/blob'
import { bytesOf } from '../core/encoding'
import { DOMException } from '../core/exception'
import { host, tag } from '../core/host'
import { typeOfName } from '../core/net'
import { env, type FileFilter, type PickedFile } from './env'

export function acceptFilters(accept: string): FileFilter[] {
  const tokens = accept.split(',').map((t) => t.trim()).filter(Boolean)
  const globs = tokens.filter((t) => t.startsWith('.')).map((t) => `*${t}`)
  const mimes = tokens.filter((t) => t.includes('/'))
  return globs.length || mimes.length ? [{ name: tokens.join(', '), globs, mimes }] : []
}

function typeFilters(types: unknown): FileFilter[] {
  if (!Array.isArray(types)) return []
  return types.flatMap((type: { description?: unknown; accept?: Record<string, unknown> }) => {
    const accept = type?.accept && typeof type.accept === 'object' ? type.accept : {}
    const mimes = Object.keys(accept)
    const globs = Object.values(accept).flatMap((exts) => (Array.isArray(exts) ? exts : [exts])).map((ext) => `*${String(ext)}`)
    return mimes.length || globs.length ? [{ name: String(type?.description ?? [...mimes, ...globs].join(', ')), globs, mimes }] : []
  })
}

export async function readPicked(file: PickedFile): Promise<File> {
  const { bytes, lastModified } = await env.files!.read(file)
  return new File([bytes], file.name, { type: typeOfName(file.name), lastModified })
}

function aborted(): DOMException {
  return new DOMException('The user aborted a request.', 'AbortError')
}

const PICKED = Symbol('picked')

export class FileSystemHandle {
  [PICKED]: PickedFile
  constructor(picked?: PickedFile) {
    if (!picked) throw new TypeError('Illegal constructor')
    this[PICKED] = picked
  }
  get kind(): string {
    return 'file'
  }
  get name(): string {
    return this[PICKED].name
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof FileSystemHandle && other[PICKED].path === this[PICKED].path
  }
  async queryPermission(): Promise<string> {
    return 'granted'
  }
  async requestPermission(): Promise<string> {
    return 'granted'
  }
}
tag(FileSystemHandle)

export class FileSystemFileHandle extends FileSystemHandle {
  getFile(): Promise<File> {
    return readPicked(this[PICKED])
  }
  async createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream> {
    const picked = this[PICKED]
    const existing = options?.keepExistingData ? (await env.files!.read(picked)).bytes : new Uint8Array(0)
    return new FileSystemWritableFileStream(picked, existing)
  }
}
tag(FileSystemFileHandle)

type WriteParams = { type: 'write'; data: unknown; position?: number } | { type: 'seek'; position: number } | { type: 'truncate'; size: number }

export class FileSystemWritableFileStream {
  readonly #picked: PickedFile
  #bytes: Uint8Array
  #size: number
  #position = 0
  #closed = false

  constructor(picked: PickedFile, existing: Uint8Array) {
    this.#picked = picked
    this.#bytes = existing.slice()
    this.#size = existing.length
  }

  get locked(): boolean {
    return false
  }

  async write(data: unknown): Promise<void> {
    if (this.#closed) throw new TypeError('The stream is closed.')
    const params = data !== null && typeof data === 'object' && 'type' in (data as object) && typeof (data as { type: unknown }).type === 'string' && !(data instanceof Blob) ? (data as WriteParams) : ({ type: 'write', data } as WriteParams)
    if (params.type === 'seek') return void (this.#position = Math.max(0, Math.trunc(params.position)))
    if (params.type === 'truncate') {
      this.#resize(Math.max(0, Math.trunc(params.size)))
      this.#size = Math.max(0, Math.trunc(params.size))
      this.#position = Math.min(this.#position, this.#size)
      return
    }
    if (params.position !== undefined) this.#position = Math.max(0, Math.trunc(params.position))
    const chunk = await chunkBytes(params.data)
    const end = this.#position + chunk.length
    this.#resize(end)
    this.#bytes.set(chunk, this.#position)
    this.#size = Math.max(this.#size, end)
    this.#position = end
  }

  seek(position: number): Promise<void> {
    return this.write({ type: 'seek', position })
  }

  truncate(size: number): Promise<void> {
    return this.write({ type: 'truncate', size })
  }

  async close(): Promise<void> {
    if (this.#closed) throw new TypeError('The stream is closed.')
    this.#closed = true
    await env.files!.write(this.#picked, this.#bytes.slice(0, this.#size))
  }

  async abort(): Promise<void> {
    this.#closed = true
  }

  getWriter(): { write(data: unknown): Promise<void>; close(): Promise<void>; abort(): Promise<void>; releaseLock(): void; ready: Promise<void> } {
    return { write: (data) => this.write(data), close: () => this.close(), abort: () => this.abort(), releaseLock: () => {}, ready: Promise.resolve() }
  }

  #resize(length: number): void {
    if (length <= this.#bytes.length) return
    const grown = new Uint8Array(Math.max(length, this.#bytes.length * 2))
    grown.set(this.#bytes.subarray(0, this.#size))
    this.#bytes = grown
  }
}
tag(FileSystemWritableFileStream)

async function chunkBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === 'string') return host.encodeUtf8(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  return bytesOf(data as ArrayBuffer)
}

export async function showOpenFilePicker(options?: { multiple?: boolean; types?: unknown; excludeAcceptAllOption?: boolean }): Promise<FileSystemFileHandle[]> {
  const picked = env.files ? await env.files.open({ multiple: !!options?.multiple, directory: false, filters: typeFilters(options?.types) }) : null
  if (!picked || picked.length === 0) throw aborted()
  return picked.map((file) => new FileSystemFileHandle(file))
}

export async function showSaveFilePicker(options?: { suggestedName?: string; types?: unknown }): Promise<FileSystemFileHandle> {
  const picked = env.files ? await env.files.save({ name: String(options?.suggestedName ?? ''), filters: typeFilters(options?.types) }) : null
  if (!picked) throw aborted()
  return new FileSystemFileHandle(picked)
}
