import type { AppManifest } from '@dopame/acde-api/manifest'

export class Frame {
  static readonly HEIGHT = 32
  static readonly #SIZE: readonly [number, number] = [800, 600]

  static height(app: Pick<AppManifest, 'frame'> | null | undefined): number {
    return app && app.frame !== false ? Frame.HEIGHT : 0
  }

  static windowSize(app: Pick<AppManifest, 'frame' | 'size'>): readonly [number, number] {
    const [width, height] = app.size ?? Frame.#SIZE
    return [width, height + Frame.height(app)]
  }
}
