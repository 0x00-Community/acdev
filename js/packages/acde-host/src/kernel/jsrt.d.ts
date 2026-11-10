declare module 'jsrt:host' {
  export function call(data: string): string
  export function call(data: ArrayBuffer | ArrayBufferView): ArrayBuffer
  export function now(): number
  export function timeOrigin(): number
  export function randomBytes<T extends ArrayBufferView>(view: T): T
  export function randomUUID(): string
  export function serialize(value: unknown): ArrayBuffer
  export function deserialize(bytes: ArrayBuffer | ArrayBufferView): unknown
  export function encodeUtf8(text: string): Uint8Array
  export function decodeUtf8(bytes: ArrayBuffer | ArrayBufferView, fatal: boolean, ignoreBom: boolean): string
  export function importModule(url: string): Promise<unknown>
  export function runModule(source: string, url: string): Promise<unknown>
  export function runScript(source: string, url: string): unknown
  export function defineModule(url: string, exports: object): void
  export function onTaskEnd(fn: (() => void) | null): void
  export function setReporter(fn: ((error: unknown, promise?: Promise<unknown>) => void) | null): void
  export function exit(code: number): never
}

declare function postMessage(data: string | ArrayBuffer | ArrayBufferView): void
declare var onmessage: ((event: { data: string | ArrayBuffer }) => void) | null
