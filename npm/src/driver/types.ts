import type { InspectAction, InspectArg, InspectMatch, InspectNode, InspectWindow } from '@acde/api'
import type { Logs } from './logs.ts'

export interface Web {
  readonly name: string
  readonly app: string | null
  readonly kind: string
  readonly window: number
  readonly title: string | null
  readonly lock?: boolean
  readonly stalled?: boolean
}

export interface WebList {
  readonly webs: readonly Web[]
  readonly locked: boolean | null
}

export interface Shot {
  readonly png: Buffer
  readonly width: number
  readonly height: number
  readonly path: string | null
}

export interface SnapshotOptions {
  readonly window?: string
  readonly ref?: string
  readonly all?: boolean
  readonly diff?: boolean
  readonly limit?: number
  readonly find?: string
  readonly tree?: boolean
  readonly offscreen?: boolean
}

export interface QueryOptions {
  readonly selector: string
  readonly window?: string
  readonly ref?: string
  readonly limit?: number
  readonly attributes?: readonly string[]
}

export interface QueryResult {
  readonly window: string
  readonly count: number
  readonly nodes: readonly InspectMatch[]
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  readonly seq: number
  readonly time: number
  readonly web: string
  readonly app: string | null
  readonly kind: 'console' | 'error' | 'rejection' | 'dialog'
  readonly level: ConsoleLevel
  readonly text: string
  readonly dialog?: Dialog
}

export type DialogType = 'alert' | 'confirm' | 'prompt'

export interface Dialog {
  readonly type: DialogType
  readonly message: string
  readonly defaultValue: string | null
  readonly answered: boolean
  readonly accept: boolean
  readonly text: string | null
}

export interface DialogAnswer {
  readonly accept?: boolean
  readonly text?: string
}

export interface RequestEntry {
  readonly seq: number
  readonly time: number
  readonly web: string
  readonly app: string | null
  readonly id: number
  readonly kind: 'fetch' | 'xhr' | 'websocket' | 'eventsource' | 'image' | 'stylesheet' | 'font'
  readonly method: string
  readonly url: string
  readonly requestBytes: number
  readonly status: number | null
  readonly statusText: string | null
  readonly responseBytes: number | null
  readonly ms: number | null
  readonly error: string | null
  readonly done: boolean
  readonly mocked?: true
}

export interface DevPage<T> {
  readonly entries: readonly T[]
  readonly next: number
  readonly dropped: number
}

export interface ConsoleOptions {
  readonly web?: string
  readonly since?: number
  readonly limit?: number
  readonly level?: ConsoleLevel | 'errors'
}

export interface NetworkOptions {
  readonly web?: string
  readonly since?: number
  readonly limit?: number
  readonly failed?: boolean
}

export interface Emulation {
  readonly colorScheme?: 'light' | 'dark' | null
}

export type GlassLevel = 'clear' | 'medium' | 'tinted'

export interface AppearanceChange {
  readonly scheme?: 'light' | 'dark' | null
  readonly glass?: GlassLevel
  readonly reducedTransparency?: boolean
}

export interface Appearance {
  readonly scheme: 'light' | 'dark' | null
  readonly glass: GlassLevel
  readonly reducedTransparency: boolean
  readonly emulated?: boolean
}

export interface Snapshot {
  readonly text: string
  readonly windows: readonly InspectWindow[]
  readonly trees: Readonly<Record<string, readonly InspectNode[]>>
}

export interface OpenTarget {
  readonly name?: string
  readonly path?: string
  readonly url?: string
}

export interface ActResult {
  readonly ok: boolean
  readonly text: string
  readonly ended?: true
}

export const ACTIONS: readonly InspectAction[] = [
  'click', 'double', 'right', 'hover', 'drag', 'type', 'settext', 'select', 'key', 'scroll', 'focus', 'close',
  'minimize', 'restore', 'fill', 'fullscreen', 'move', 'resize', 'raise',
]

export interface Step {
  readonly ref: string
  readonly action: InspectAction
  readonly arg?: InspectArg
}

export type UrlMatch = string | RegExp

export type RouteResponse =
  | {
      readonly status?: number
      readonly statusText?: string
      readonly headers?: Readonly<Record<string, string>>
      readonly contentType?: string
      readonly body?: string | Uint8Array
      readonly json?: unknown
    }
  | { readonly abort: true | string }

export interface RouteOptions {
  readonly method?: string
  readonly web?: string
  readonly times?: number
}

export interface WaitRequestOptions {
  readonly method?: string
  readonly web?: string
  readonly timeout?: number
}

export interface WaitConsoleOptions {
  readonly level?: ConsoleLevel | 'errors'
  readonly web?: string
  readonly timeout?: number
}

export interface AttachOptions {
  readonly session?: number | 'vm'
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly say?: (line: string) => void
}

export interface LaunchOptions {
  readonly dirs?: readonly string[]
  readonly desktop?: string
  readonly app?: string
  readonly out?: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly headless?: boolean
  readonly timeout?: number
  readonly startTimeout?: number
  readonly force?: boolean
}

export interface PermissionPrompt {
  readonly id: number
  readonly app: string
  readonly label: string
  readonly capability: string
  readonly reason: string
}

export interface PermissionDecision {
  readonly app: string
  readonly label: string | null
  readonly capability: string
  readonly decision: 'granted' | 'denied'
  readonly folder?: { readonly label: string; readonly exists: boolean }
}

export interface Permissions {
  readonly pending: readonly PermissionPrompt[]
  readonly decisions: readonly PermissionDecision[]
}

export interface PromptMatch {
  readonly app?: string
  readonly capability?: string
  readonly timeout?: number
}

export interface DropOptions {
  readonly web?: string
  readonly x?: number
  readonly y?: number
}

export interface Dropped {
  readonly web: string
  readonly window: number
  readonly files: readonly string[]
}

export class ActError extends Error {
  readonly result: ActResult

  constructor(what: string, result: ActResult) {
    super(`${what}: ${result.text}`)
    this.name = 'ActError'
    this.result = result
  }
}

export type LaunchPhase = 'session' | 'window' | 'exited' | 'failed'

export class LaunchError extends Error {
  static readonly TAIL = 40

  readonly #phase: LaunchPhase
  readonly #logs: Logs
  readonly #code: number | null

  constructor(phase: LaunchPhase, said: string, logs: Logs, options: { code?: number; cause?: unknown } = {}) {
    super(said, options.cause === undefined ? undefined : { cause: options.cause })
    this.#phase = phase
    this.#logs = logs
    this.#code = options.code ?? null
  }

  get phase(): LaunchPhase {
    return this.#phase
  }

  get logs(): Logs {
    return this.#logs
  }

  get code(): number | null {
    return this.#code
  }

  static stalled(phase: 'session' | 'window' | 'exited', head: string, logs: Logs, code?: number): LaunchError {
    const said = `${head}\n${logs.tail(LaunchError.TAIL).text}`
    return new LaunchError(phase, said, logs, code === undefined ? {} : { code })
  }
}