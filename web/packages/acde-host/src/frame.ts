import type { DoubleClickAction, FrameTheme } from '@dopame/acde-api'
import { FrameThemes, type AppManifest } from '@dopame/acde-api/manifest'
import type { NativeSurface } from './native'
import { Level, Log } from './log'

interface SchemePage {
  readonly document: { readonly documentElement: Element | null; readonly head: Element | null; querySelector(selector: string): Element | null }
  getComputedStyle(element: Element): { getPropertyValue(name: string): string }
  readonly MutationObserver: new (callback: () => void) => { observe(target: unknown, options: Record<string, boolean>): void; disconnect(): void }
}

const DARK = /(^|\s)dark(\s|$)/i

export class Frame {
  static readonly HEIGHT = 32
  static readonly #SIZE: readonly [number, number] = [800, 600]
  static readonly DOUBLE_CLICK: readonly DoubleClickAction[] = ['fill', 'minimize', 'none']

  static height(app: Pick<AppManifest, 'frame'> | null | undefined): number {
    return app && app.frame !== false ? Frame.HEIGHT : 0
  }

  static windowSize(app: Pick<AppManifest, 'frame' | 'size'>): readonly [number, number] {
    const [width, height] = app.size ?? Frame.#SIZE
    return [width, height + Frame.height(app)]
  }

  static desktop(
    surface: Pick<NativeSurface, 'setDoubleClick' | 'setFrameTheme'>,
    warn: (line: string) => void = (line) => Log.write(Level.Warn, 'acde_host', line),
  ): {
    setDoubleClick(action: DoubleClickAction): void
    setFrameTheme(theme: FrameTheme | null): void
  } {
    return {
      setFrameTheme: (theme) => {
        const wire = FrameThemes.parse(theme)
        if (typeof wire === 'string') throw new TypeError(`setFrameTheme: ${wire}`)
        if (wire.ignored.length) warn(`setFrameTheme: ignored ${wire.ignored.join(', ')} (not known to this runtime)`)
        surface.setFrameTheme?.(...wire.colors, wire.style, wire.side, wire.align)
      },
      setDoubleClick: (action) => {
        if (!Frame.DOUBLE_CLICK.includes(action)) throw new TypeError(`setDoubleClick: no action ${String(action)} (${Frame.DOUBLE_CLICK.join(', ')})`)
        surface.setDoubleClick?.(action)
      },
    }
  }

  static darkPage(page: SchemePage): boolean {
    const meta = page.document.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') ?? ''
    if (DARK.test(meta.trim())) return true
    const root = page.document.documentElement
    return !!root && DARK.test(page.getComputedStyle(root).getPropertyValue('color-scheme').trim())
  }

  static followScheme(page: SchemePage, surface: Pick<NativeSurface, 'setPageDark'>, later: (run: () => void) => void): void {
    if (!surface.setPageDark) return
    let shown: boolean | null = null
    let queued = false
    const watched: { root: Element | null; head: Element | null } = { root: null, head: null }
    const schedule = () => {
      if (queued) return
      queued = true
      later(check)
    }
    const top = new page.MutationObserver(schedule)
    const root = new page.MutationObserver(schedule)
    const head = new page.MutationObserver(schedule)
    const bind = () => {
      const { documentElement, head: current } = page.document
      if (documentElement !== watched.root) {
        root.disconnect()
        watched.root = documentElement
        if (documentElement) root.observe(documentElement, { attributes: true, childList: true })
      }
      if (current !== watched.head) {
        head.disconnect()
        watched.head = current
        if (current) head.observe(current, { subtree: true, childList: true, attributes: true, characterData: true })
      }
    }
    const check = () => {
      queued = false
      bind()
      const dark = Frame.darkPage(page)
      if (dark === shown) return
      shown = dark
      surface.setPageDark?.(dark)
    }
    top.observe(page.document, { childList: true })
    check()
  }
}
