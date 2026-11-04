import type { HostNative } from '@dopame/acde-dom'

export interface FileStat {
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
  readonly size: number
  readonly mtimeMs: number
  readonly mode: number
}

export interface SysNative {
  readonly argv: readonly string[]
  env(): Record<string, string>
  exit(code: number): never
  cwd(): string
  homedir(): string
  getuid(): number
  readFile(path: string): Uint8Array
  readText(path: string): string
  writeFile(path: string, data: string | Uint8Array): void
  exists(path: string): boolean
  stat(path: string): FileStat | null
  readDir(path: string): string[]
  mkdir(path: string, recursive?: boolean): void
  rename(from: string, to: string): void
  remove(path: string, recursive?: boolean): void
  chmod(path: string, mode: number): void
  realpath(path: string): string
  stdout(text: string): void
  stderr(text: string): void
  kill(pid: number, signal?: string): boolean
  run(argv: readonly string[], timeoutMs?: number): { status: number | null; stdout: string; stderr: string }
  onSignal(callback: (name: 'SIGINT' | 'SIGTERM' | 'SIGHUP') => void): void
  spawn?(argv: readonly string[], options: { cwd?: string; env: Record<string, string>; prefix: string; stdin?: boolean; onStdout?: (line: string) => void }, onExit: (code: number | null, signal: number | null) => void): number
  write?(pid: number, text: string): boolean
  endInput?(pid: number): void
  /** The desk (crates/acde `desk/`), opened on the first call with what every isolate's init carries. */
  desk?(look: object): unknown
}

export interface Natives {
  readonly host: HostNative
  /** The Broker's; a desktop or window isolate has none. */
  readonly sys?: SysNative
  /** The environment the Broker gave a desktop or window isolate. */
  readonly env?: Record<string, string>
  readonly native?: Readonly<Record<string, unknown>>
}

let current: Natives | null = null

export function bindNatives(natives: Natives): void {
  current = natives
}

export function natives(): Natives {
  if (!current) throw new Error('acde-host: natives used before the entry bound them')
  return current
}

export function sys(): SysNative {
  const sys = natives().sys
  if (!sys) throw new Error('acde-host: sys is the Broker\'s; a desktop or window isolate has none')
  return sys
}
