import type { RawShellEvent } from '../native'

export interface WorkArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Screen {
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly workArea: WorkArea
}

export class Output {
  width: number
  height: number
  scale: number
  #workArea: WorkArea | null = null

  constructor(width: number, height: number, scale: number) {
    this.width = width * scale
    this.height = height * scale
    this.scale = scale
  }

  screen(): Screen {
    const scale = this.scale || 1
    const [width, height] = [Math.round(this.width / scale), Math.round(this.height / scale)]
    return { width, height, scale: this.scale, workArea: this.#workArea ?? { x: 0, y: 0, width, height } }
  }

  update(event: RawShellEvent, prefix = ''): Screen | null {
    const was = JSON.stringify(this.screen())
    const type = event.type.startsWith(prefix) ? event.type.slice(prefix.length) : ''
    if (type === 'output' && event.width && event.height) {
      this.width = event.width
      this.height = event.height
      this.scale = event.scale ?? this.scale
    } else if (type === 'workarea' && event.width && event.height) {
      this.#workArea = { x: event.x ?? 0, y: event.y ?? 0, width: event.width, height: event.height }
    } else return null
    const screen = this.screen()
    return JSON.stringify(screen) === was ? null : screen
  }
}

export interface ScreenChange {
  readonly screen: Screen
  to(window: Parameters<typeof Outputs.host>[0]): boolean
}

export class Outputs {
  readonly main: Output
  #host: Output | null = null
  readonly #changed = new Map<boolean, ScreenChange>()

  constructor(width: number, height: number, scale: number) {
    this.main = new Output(width, height, scale)
  }

  static host(window: { readonly mode?: string; readonly appId?: string | null } | undefined, standalone: string | null): boolean {
    return !!window && window.mode === 'fullscreen' && !!standalone && window.appId === standalone
  }

  get hosted(): boolean {
    return this.#host !== null
  }

  screen(host: boolean): Screen {
    return (host && this.#host?.screen()) || this.main.screen()
  }

  update(event: RawShellEvent, standalone: string | null): ScreenChange | null {
    const host = event.type.startsWith('host')
    if (host) this.#host ??= new Output(0, 0, event.scale ?? 1)
    const screen = host ? this.#host!.update(event, 'host') : this.main.update(event)
    const change = screen && { screen, to: (window: Parameters<typeof Outputs.host>[0]) => host === (this.hosted && Outputs.host(window, standalone)) }
    if (change) this.#changed.set(host, change)
    return change
  }

  take(): ScreenChange[] {
    const changes = [...this.#changed.values()]
    this.#changed.clear()
    return changes
  }
}