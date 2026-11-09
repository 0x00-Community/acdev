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

  update(event: RawShellEvent): Screen | null {
    const was = JSON.stringify(this.screen())
    if (event.type === 'output' && event.width && event.height) {
      this.width = event.width
      this.height = event.height
      this.scale = event.scale ?? this.scale
    } else if (event.type === 'workarea' && event.width && event.height) {
      this.#workArea = { x: event.x ?? 0, y: event.y ?? 0, width: event.width, height: event.height }
    } else return null
    const screen = this.screen()
    return JSON.stringify(screen) === was ? null : screen
  }
}
