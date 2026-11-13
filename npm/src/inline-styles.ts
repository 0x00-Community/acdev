import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

export class InlineStyles {
  static readonly BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi
  static readonly ATTRIBUTE = /(\sstyle\s*=\s*)("[^"]*"|'[^']*')/gi
  static readonly URL = /url\(\s*(["']?)([^"')\s]+)\1\s*\)/g
  static readonly KEPT = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i
  static readonly REFERENCE = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi
  static readonly NAMED: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }

  readonly #copied = new Map<string, string>()

  constructor(readonly entry: string, readonly out: string, readonly base: string, readonly dir: string) {}

  static bundle(entry: string, page: string, out: string, base: string, dir: string): void {
    const text = readFileSync(page, 'utf8')
    const styles = new InlineStyles(entry, out, base, dir)
    const done = styles.rewrite(text)
    if (done !== text) writeFileSync(page, done)
  }

  rewrite(html: string): string {
    return html
      .replace(InlineStyles.BLOCK, (_, open: string, css: string, close: string) => open + this.#css(css) + close)
      .replace(InlineStyles.ATTRIBUTE, (_, before: string, value: string) =>
        before + value[0] + this.#attribute(value.slice(1, -1), value[0]!) + value[0])
  }

  #attribute(raw: string, quote: string): string {
    const css = InlineStyles.decode(raw)
    const done = this.#css(css)
    return done === css ? raw : InlineStyles.encode(done, quote)
  }

  static decode(text: string): string {
    return text.replace(InlineStyles.REFERENCE, (whole, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) return InlineStyles.NAMED[name.toLowerCase()] ?? whole
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
  }

  static encode(text: string, quote: string): string {
    const amp = text.replace(/&(?![a-z][a-z0-9]*;)/gi, '&amp;')
    return quote === '"' ? amp.replaceAll('"', '&quot;') : amp.replaceAll("'", '&#39;')
  }

  #css(css: string): string {
    return css.replace(InlineStyles.URL, (whole, quote: string, url: string) =>
      (InlineStyles.KEPT.test(url) ? whole : `url(${quote}${this.#asset(url)}${quote})`))
  }

  #asset(url: string): string {
    const clean = url.replace(/[?#].*$/s, '')
    const file = resolve(dirname(this.entry), decodeURIComponent(clean))
    if (!existsSync(file) || !statSync(file).isFile()) {
      const where = relative(this.dir, this.entry) || this.entry
      throw new Error(`${url} in an inline style in ${where}: there is no ${relative(this.dir, file) || file}`)
    }
    let name = this.#copied.get(file)
    if (name === undefined) {
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)
      const ext = extname(file)
      name = `${basename(file, ext)}-${hash}${ext}`
      copyFileSync(file, join(this.out, name))
      this.#copied.set(file, name)
    }
    return this.base + encodeURI(name) + url.slice(clean.length)
  }
}
