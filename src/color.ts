export type Paint = (text: string) => string

export interface Palette {
  readonly on: boolean
  readonly heading: Paint
  readonly name: Paint
  readonly option: Paint
  readonly dim: Paint
  readonly ok: Paint
  readonly warn: Paint
  readonly error: Paint
}

export class Color {
  static enabled(stream: { readonly isTTY?: boolean } = process.stdout, env = process.env): boolean {
    if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
    const forced = env['FORCE_COLOR']
    if (forced !== undefined) return forced !== '0' && forced !== 'false'
    return stream.isTTY === true && env['TERM'] !== 'dumb'
  }

  static palette(on = Color.enabled()): Palette {
    const sgr = (open: string, close: string): Paint =>
      on ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => text
    return {
      on,
      heading: sgr('1;32', '22;39'),
      name: sgr('1;36', '22;39'),
      option: sgr('36', '39'),
      dim: sgr('2', '22'),
      ok: sgr('32', '39'),
      warn: sgr('33', '39'),
      error: sgr('1;31', '22;39'),
    }
  }

  static width(text: string): number {
    return text.replace(/\x1b\[[0-9;]*m/g, '').length
  }
}
