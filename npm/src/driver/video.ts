import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Acde } from './acde.ts'
import { Png } from './png.ts'

interface Frame {
  readonly png: Buffer
  readonly at: number
}

export class Video {
  static readonly FPS = 4
  static readonly MAX_FRAMES = 600

  readonly #acde: Acde
  readonly #frames: Frame[] = []
  #stopped = false
  #dropped = 0
  readonly #loop: Promise<void>

  private constructor(acde: Acde, fps: number) {
    this.#acde = acde
    this.#loop = this.#record(1000 / fps)
  }

  static start(acde: Acde, fps = Video.FPS): Video {
    return new Video(acde, fps)
  }

  get frames(): number {
    return this.#frames.length
  }

  async stop(): Promise<void> {
    this.#stopped = true
    await this.#loop
  }

  write(path: string): { readonly frames: number; readonly dropped: number } | null {
    if (!this.#frames.length) return null
    const end = Date.now()
    const shown = (i: number) => Math.min(65_535, (this.#frames[i + 1]?.at ?? end) - this.#frames[i]!.at)
    const frames = this.#frames.map((f, i) => ({ png: f.png, ms: shown(i) }))
    writeFileSync(path, Png.animate(frames))
    return { frames: frames.length, dropped: this.#dropped }
  }

  async #record(interval: number): Promise<void> {
    while (!this.#stopped) {
      const started = Date.now()
      try {
        const { png } = await this.#acde.screen()
        const last = this.#frames[this.#frames.length - 1]
        if (!last || !last.png.equals(png)) {
          this.#frames.push({ png, at: started })
          if (this.#frames.length > Video.MAX_FRAMES) {
            this.#frames.shift()
            this.#dropped++
          }
        }
      } catch {
        if (this.#acde.closed) return
      }
      await sleep(Math.max(0, interval - (Date.now() - started)))
    }
  }
}
