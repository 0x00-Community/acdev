import { xdgHome } from './sys/os'
import { join } from './sys/path'
import { process } from './sys/process'
import { StorageFile } from './storage'

export type Rect = [number, number, number, number]

export class WindowPlaces {
  static readonly VISIBLE = 48
  readonly #file: StorageFile | null
  readonly #rects: Record<string, string>

  static over(
    row: { x: number; y: number; width: number; height: number },
    [w, h]: readonly [number, number],
    screen: { width: number; height: number },
  ): Rect {
    const width = Math.min(w, screen.width)
    const height = Math.min(h, screen.height)
    const x = Math.round(Math.min(Math.max(0, row.x + (row.width - width) / 2), screen.width - width))
    const y = Math.round(Math.min(Math.max(0, row.y + (row.height - height) / 2), screen.height - height))
    return [x, y, width, height]
  }

  constructor() {
    this.#file = process.env['ACDE_STORAGE'] === '' ? null : new StorageFile(join(xdgHome('state'), 'acde', 'windows.json'))
    this.#rects = this.#file?.read() ?? {}
  }

  get(app: string, screen: { width: number; height: number }): Rect | null {
    let rect: unknown
    try {
      rect = JSON.parse(this.#rects[app] ?? 'null')
    } catch {
      return null
    }
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null
    const [x, y, w, h] = rect as Rect
    const width = Math.min(w, screen.width)
    const height = Math.min(h, screen.height)
    if (width < 1 || height < 1) return null
    const shown = x + width >= WindowPlaces.VISIBLE && x <= screen.width - WindowPlaces.VISIBLE && y >= 0 && y <= screen.height - WindowPlaces.VISIBLE
    return shown ? [x, y, width, height] : null
  }

  set(app: string, rect: Rect): void {
    if (!rect.every(Number.isFinite) || rect[2] < 1 || rect[3] < 1) return
    this.#rects[app] = JSON.stringify(rect.map(Math.round))
    this.#file?.changed({ ...this.#rects })
  }

  flush(): void {
    this.#file?.flush()
  }
}
