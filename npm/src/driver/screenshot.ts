import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { InspectNode, InspectWindow } from '@acde/api'
import { Png, type Image } from './png.ts'

export type Box = readonly [number, number, number, number]

export interface Capture {
  readonly image: Image
  readonly window: InspectWindow
  readonly scale: number
}

export interface Capturable {
  capture(): Promise<Capture>
  rects(): Promise<readonly (readonly [number, number, number, number])[]>
  describe(): string
}

export interface ScreenshotOptions {
  readonly path?: string
  readonly mask?: readonly Capturable[]
}

export interface ScreenshotContext {
  readonly dir: string
  readonly results: string | null
  readonly update: boolean
  readonly ci: boolean
  readonly test: string
}

export class Screenshots {
  static readonly MASK: readonly [number, number, number, number] = [255, 0, 255, 255]
  static context: ScreenshotContext | null = null
  static #counts = new Map<string, number>()

  static async window(capture: Capture, mask: readonly Capturable[] = []): Promise<Image> {
    return Screenshots.#masked(capture.image, capture, [0, 0], mask)
  }

  static async element(capture: Capture, node: InspectNode, mask: readonly Capturable[] = []): Promise<Image> {
    const rect = node.rect
    if (!rect || rect[2] <= 0 || rect[3] <= 0) throw new Error(`${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''} [${node.ref}] has no size to take a picture of`)
    const [wx, wy] = capture.window.rect
    const s = capture.scale
    const x = (rect[0] - wx) * s
    const y = (rect[1] - wy) * s
    const cropped = Png.crop(capture.image, x, y, rect[2] * s, rect[3] * s)
    if (!cropped.width || !cropped.height) throw new Error(`[${node.ref}] lies outside its window`)
    return Screenshots.#masked(cropped, capture, [x, y], mask)
  }

  static rect(text: string): Box | null {
    const parts = text.split(',').map((v) => Number(v.trim()))
    if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2]! <= 0 || parts[3]! <= 0) return null
    return parts as unknown as Box
  }

  static within(image: Image, frame: Box, rect: Box, what: string): Image {
    const [fx, fy, fw, fh] = frame
    const [x, y, w, h] = rect
    const box = (b: Box) => `${b.map((v) => Math.round(v * 100) / 100).join(',')}`
    if (w <= 0 || h <= 0) throw new Error(`${what} has no size to take a picture of`)
    const slack = 0.5
    if (x + w <= fx || y + h <= fy || x >= fx + fw || y >= fy + fh) throw new Error(`${what} (${box(rect)}) is outside the picture (${box(frame)})`)
    if (x < fx - slack || y < fy - slack || x + w > fx + fw + slack || y + h > fy + fh + slack)
      throw new Error(`${what} (${box(rect)}) reaches past the picture (${box(frame)}); scroll it into view or give a smaller rect`)
    const sx = fw > 0 ? image.width / fw : 1
    const sy = fh > 0 ? image.height / fh : sx
    return Png.crop(image, (x - fx) * sx, (y - fy) * sy, w * sx, h * sy)
  }

  static save(image: Image, path: string | undefined): Buffer {
    const png = Png.encode(image)
    if (path !== undefined) {
      mkdirSync(dirname(resolve(path)), { recursive: true })
      writeFileSync(resolve(path), png)
    }
    return png
  }

  static baseline(name: string | undefined): { path: string; label: string } {
    const context = Screenshots.context
    const platform = process.platform
    if (name !== undefined && (isAbsolute(name) || /[\\/]/.test(name) || !context)) {
      const path = resolve(name.endsWith('.png') ? name : `${name}.png`)
      return { path, label: basename(path, '.png') }
    }
    if (!context) throw new Error('toHaveScreenshot: give the baseline file (a .png path) outside acdev test')
    let label = name
    if (label === undefined) {
      const key = `${context.dir}\u0000${context.test}`
      const n = (Screenshots.#counts.get(key) ?? 0) + 1
      Screenshots.#counts.set(key, n)
      label = `${Screenshots.slug(context.test)}-${n}`
    }
    const base = label.replace(/\.png$/i, '')
    return { path: join(context.dir, `${Screenshots.slug(base)}-${platform}.png`), label: base }
  }

  static read(path: string): Image | null {
    return existsSync(path) ? Png.decode(readFileSync(path)) : null
  }

  static slug(text: string): string {
    return (
      text
        .replace(/[<>:"/\\|?*\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'screenshot'
    )
  }

  static async #masked(image: Image, capture: Capture, origin: readonly [number, number], mask: readonly Capturable[]): Promise<Image> {
    let out = image
    const [wx, wy] = capture.window.rect
    for (const target of mask) {
      for (const [x, y, w, h] of await target.rects()) {
        out = Png.fill(out, (x - wx) * capture.scale - origin[0], (y - wy) * capture.scale - origin[1], w * capture.scale, h * capture.scale, Screenshots.MASK)
      }
    }
    return out
  }
}
