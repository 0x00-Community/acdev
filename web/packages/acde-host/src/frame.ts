import type { DoubleClickAction, FrameTheme } from '@dopame/acde-api'
import { FrameThemes, type AppManifest } from '@dopame/acde-api/manifest'
import type { NativeSurface } from './native'

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

  static desktop(surface: Pick<NativeSurface, 'setDoubleClick' | 'setFrameTheme'>): {
    setDoubleClick(action: DoubleClickAction): void
    setFrameTheme(theme: FrameTheme | null): void
  } {
    return {
      setFrameTheme: (theme) => {
        const wire = FrameThemes.parse(theme)
        if (typeof wire === 'string') throw new TypeError(`setFrameTheme: ${wire}`)
        surface.setFrameTheme?.(...wire.colors, wire.style, wire.side, wire.align)
      },
      setDoubleClick: (action) => {
        if (!Frame.DOUBLE_CLICK.includes(action)) throw new TypeError(`setDoubleClick: no action ${String(action)} (${Frame.DOUBLE_CLICK.join(', ')})`)
        surface.setDoubleClick?.(action)
      },
    }
  }
}
