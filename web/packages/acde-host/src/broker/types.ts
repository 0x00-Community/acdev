import type { NativeWindow, WindowState } from '@dopame/acde-api'
import type { AppManifest } from '../apps'
import type { DevRoute } from '../devroutes'
import type { Languages } from '../language'
import type { RawShellEvent } from '../native'
import type { InstalledDesktop, Packages } from '../packages'
import type { StoragePlace } from '../storage'
import type { WebTier } from './access/tier'
import type { Web } from './web'

export interface BrokerShell {
  pump(): RawShellEvent[]
  onEvents(callback: () => void): void
  grant(options?: {
    desktop?: boolean
    hidden?: boolean
    window?: number
    mode?: 'fullscreen' | 'free' | 'fixed' | 'pinned'
    rect?: number[]
    size?: readonly number[]
    parent?: number
    modal?: boolean
    host?: boolean
  }): { window: number; token: bigint }
  place(window: number, x: number, y: number, width: number, height: number): void
  release(window: number): void
  focus(window: number): void
  hide(window: number, hidden: boolean): void
  setState?(window: number, state: 'normal' | 'minimized' | 'filled' | 'fullscreen'): void
  close(window: number): void
  launch(argv: string[], options?: { cwd?: string; env?: Record<string, string> }): number
  screenshot(path: string): Promise<{ width: number; height: number }>
  stats(reset?: boolean): Record<string, unknown>
  windows(): ShellWindow[]
  animate(window: number, options: AnimateOptions): void
  shortcut(combo: string, scope: 'session' | 'desktop' | 'app', owner: number): void
  unshortcut(combo: string, scope: 'session' | 'desktop' | 'app', owner: number): void
  inject(event: {
    type: 'move' | 'motion' | 'down' | 'up' | 'wheel' | 'keydown' | 'keyup'
    x?: number
    y?: number
    button?: number
    dx?: number
    dy?: number
    source?: 'wheel' | 'finger' | 'continuous'
    code?: number
  }): void
  quit(): void
  capture?(window: number): Promise<{ width: number; height: number; png: string }>
  devRespond?(id: number, ok: boolean, payload: string): void
  notify?(title: string, body: string, subtitle: string): void
  answerFolder?(path: string | null): void
  answerOpen?(paths: string[] | null): void
  drop?(window: number, paths: string[], x?: number, y?: number): void
  answerSave?(path: string | null): void
  openDefault?(target: string): Promise<void>
  fileHandlers?(extension: string): Promise<{ id: string; label: string; icon: string; default: boolean }[]>
  openWith?(handler: string, path: string): Promise<void>
  approve?(title: string, message: string): Promise<boolean | null>
  dismissApproval?(): void
  readClipboard?(): string
  resizeScreen?(width: number, height: number): void
  writeClipboard?(text: string): void
  readonly socketName: string
  readonly hosted?: boolean
}

export interface WebInfo {
  readonly name: string
  readonly app: string | null
  readonly kind: 'desktop' | 'app'
  readonly window: number
  readonly title: string
}

export interface ShellWindow {
  readonly id: number
  readonly state?: 'normal' | 'minimized' | 'filled' | 'fullscreen'
  readonly window?: number
  readonly canvas: number
  readonly mode: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly z: number
  readonly focus: boolean
  readonly hidden?: boolean
  readonly pid?: number | null
  readonly parent?: number | null
  readonly modal?: boolean
  readonly minimize?: boolean
}

export interface AnimateOptions {
  opacity?: number
  scale?: number
  dx?: number
  dy?: number
  duration?: number
  delay?: number
  easing?: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
}

export interface BrokerOptions {
  readonly packages: Packages
  readonly desktop: InstalledDesktop
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly reducedMotion: boolean | null
  readonly dark: boolean
  readonly session: boolean
  readonly storage: (desktop: string) => StoragePlace
  readonly standalone: string | null
}

export interface WireMenu {
  readonly id: string
  readonly label: string
  readonly items: readonly (WireMenuSeparator | WireMenuItem)[]
}

interface WireMenuSeparator {
  readonly type: 'separator'
}

interface WireMenuItem {
  readonly id: string
  readonly label: string
  readonly shortcut?: string
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly action: boolean
}

export interface WebInit {
  readonly kind: 'desktop' | 'window'
  readonly name: string
  readonly token: bigint
  readonly window: number
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly screen?: { width: number; height: number; workArea?: { x: number; y: number; width: number; height: number } }
  readonly reducedMotion: boolean | null
  readonly dark: boolean
  readonly languages: Languages
  readonly navigator: { readonly userAgent: string; readonly platform: string }
  readonly services: Readonly<Record<string, ServiceShape>>
  readonly resources: { prefix: string; dirs: string[] }[]
  readonly page?: string
  readonly standalone?: string | null
  readonly app?: AppManifest
  readonly theme?: string
  readonly request?: Record<string, unknown> | null
  readonly url?: string | null
  readonly sockets?: string
  readonly channel?: boolean
  readonly devState?: unknown
  readonly devRoutes?: readonly DevRoute[]
  readonly devInit?: readonly string[]
  readonly tier: WebTier
  readonly windows?: readonly NativeWindow[]
}

export interface ServiceShape {
  readonly methods: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
  readonly sync: Readonly<Record<string, unknown>>
  readonly callable: boolean
}

export interface WindowRecord {
  readonly id: number
  readonly kind: 'native' | 'web'
  appId: string | null
  title: string | null
  owner: Web | null
  starter?: Web | null
  web: Web | null
  app: AppManifest | null
  menus: WireMenu[]
  request?: Record<string, unknown> | null
  url?: string | null
  mode?: 'fullscreen' | 'free'
  hidden?: boolean
  state?: WindowState
}
