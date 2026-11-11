import type { AcdeWindow, FrameColors, FrameTheme, WindowEdge } from '@dopame/acde-api'

type Button = 'close' | 'minimize' | 'fullscreen'

interface Look {
  readonly style: 'dots' | 'glyphs'
  readonly side: 'left' | 'right'
  readonly align: 'center' | 'start'
  readonly active: Required<FrameColors>
  readonly inactive: Required<FrameColors>
}

const GLYPHS = {
  minimize: 'M0.5 5.5h10',
  maximize: 'M0.5 0.5h10v10h-10z',
  restore: 'M0.5 2.5h8v8h-8z M2.5 2.5v-2h8v8h-2',
  close: 'M0.5 0.5l10 10 M10.5 0.5l-10 10',
} as const

export class DefaultFrame {
  static readonly HEIGHT = 32
  static readonly #EDGE = 4
  static readonly #CORNER = 10
  static readonly #DOTS = 76
  static readonly #CAPTION = 46
  static readonly #ACTIVE: Required<FrameColors> = { background: '#f4f2f7', title: '#3a3542', line: 'rgba(0,0,0,.08)', buttons: '#3a3542' }
  static readonly #INACTIVE: Required<FrameColors> = { background: '#f4f2f7', title: '#9a96a1', line: 'rgba(0,0,0,.06)', buttons: '#d3d0d8' }
  static readonly #DOT_COLORS: Record<Button, string> = { close: '#ff5f57', minimize: '#febc2e', fullscreen: '#28c840' }
  static readonly #LABELS = {
    close: ['关闭', 'Close'],
    minimize: ['最小化', 'Minimize'],
    fullscreen: ['全屏', 'Full Screen'],
    maximize: ['最大化', 'Maximize'],
    restore: ['还原', 'Restore'],
  } as const
  static readonly #ROOT = `box-sizing:border-box!important;padding-top:${DefaultFrame.HEIGHT}px!important;height:100%!important`

  readonly #window: AcdeWindow
  readonly #document: Document
  readonly #element: HTMLElement
  readonly #title: HTMLElement
  #buttons: [Button, HTMLElement, SVGPathElement | null][] = []
  #theme: FrameTheme | null
  #look: Look
  #active = true
  #fullscreen = false
  #size = ''

  constructor(window: AcdeWindow, document: Document, title: string, theme: unknown) {
    this.#window = window
    this.#document = document
    this.#theme = DefaultFrame.#parse(theme)
    this.#look = this.#resolve()
    this.#element = this.#el('acde-frame', '')
    this.#element.setAttribute('aria-hidden', 'true')
    this.#title = this.#el('acde-frame-title', '')
    this.title(title)
    this.#build()
  }

  install(onTitle: (handler: (title: string) => void) => void): void {
    const view = this.#view()
    this.#attach()
    new view.MutationObserver(() => this.#attach()).observe(this.#document.documentElement, { childList: true, attributes: true, attributeFilter: ['style'] })
    view.addEventListener('resize', () => this.#hints())
    view.addEventListener('languagechange', () => this.#labels())
    onTitle((title) => this.title(title))
    this.#window.on('activate', () => this.#activate(true))
    this.#window.on('deactivate', () => this.#activate(false))
    this.#hints()
  }

  title(text: string): void {
    if (this.#title.textContent !== text) this.#title.textContent = text
  }

  theme(theme: unknown): void {
    this.#theme = DefaultFrame.#parse(theme)
    const before = this.#look
    this.#look = this.#resolve()
    if (before.style !== this.#look.style || before.side !== this.#look.side || before.align !== this.#look.align) {
      this.#build()
      this.#size = ''
      this.#hints()
    } else {
      this.#paint()
    }
  }

  static #parse(theme: unknown): FrameTheme | null {
    return theme && typeof theme === 'object' ? (theme as FrameTheme) : null
  }

  #resolve(): Look {
    const t = this.#theme
    const pick = t?.light && !this.#darkPage() ? t.light : t
    return {
      style: t?.buttonStyle === 'glyphs' ? 'glyphs' : 'dots',
      side: t?.buttonSide === 'right' || (t?.buttonSide !== 'left' && t?.buttonStyle === 'glyphs') ? 'right' : 'left',
      align: t?.titleAlign === 'start' || (t?.titleAlign !== 'center' && t?.buttonStyle === 'glyphs') ? 'start' : 'center',
      active: { ...DefaultFrame.#ACTIVE, ...DefaultFrame.#pick(pick?.active) },
      inactive: { ...DefaultFrame.#INACTIVE, ...DefaultFrame.#pick(pick?.active), ...DefaultFrame.#pick(pick?.inactive) },
    }
  }

  static #pick(c: FrameColors | undefined): Partial<FrameColors> {
    const out: Record<string, string> = {}
    for (const key of ['background', 'title', 'line', 'buttons'] as const) {
      const v = c?.[key]
      if (typeof v === 'string' && v) out[key] = v
    }
    return out
  }

  #darkPage(): boolean {
    const root = this.#document.documentElement
    const meta = this.#document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? ''
    let computed = ''
    try {
      computed = root ? this.#view().getComputedStyle(root).getPropertyValue('color-scheme') : ''
    } catch {}
    return /dark/.test(`${meta} ${computed}`)
  }

  #colors(): Required<FrameColors> {
    return this.#active ? this.#look.active : this.#look.inactive
  }

  #build(): void {
    this.#buttons = []
    const buttons = this.#look.style === 'glyphs' ? this.#captions() : this.#dots()
    const room = this.#look.style === 'glyphs' ? 3 * DefaultFrame.#CAPTION : DefaultFrame.#DOTS
    const pad = this.#look.align === 'center'
      ? (this.#look.side === 'left' ? `margin-right:${room}px!important;` : `margin-left:${room}px!important;`)
      : (this.#look.side === 'left' ? 'margin-left:4px!important;' : 'margin-left:12px!important;')
    this.#title.setAttribute('style', `all:initial!important;flex:1!important;min-width:0!important;${pad}`
      + `text-align:${this.#look.align === 'center' ? 'center' : 'left'}!important;`
      + 'white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font:inherit!important;color:inherit!important')
    while (this.#element.firstChild) this.#element.firstChild.remove()
    if (this.#look.side === 'left') this.#element.append(buttons, this.#title)
    else this.#element.append(this.#title, buttons)
    this.#labels()
    this.#paint()
  }

  #paint(): void {
    const c = this.#colors()
    this.#element.setAttribute('style', 'all:initial!important;position:fixed!important;z-index:2147483646!important;'
      + `left:0!important;top:0!important;right:0!important;height:${DefaultFrame.HEIGHT}px!important;`
      + 'display:flex!important;align-items:center!important;box-sizing:border-box!important;'
      + `border-bottom:1px solid ${c.line}!important;background:${c.background}!important;`
      + `font:600 13px/1 system-ui,sans-serif!important;color:${c.title}!important;user-select:none!important;cursor:default!important`)
    for (const [kind, button, path] of this.#buttons) {
      if (this.#look.style === 'dots') button.setAttribute('style', this.#dotStyle(kind))
      else path?.setAttribute('stroke', c.buttons)
    }
  }

  #dotStyle(kind: Button): string {
    const fill = this.#active ? DefaultFrame.#DOT_COLORS[kind] : this.#colors().buttons
    return 'all:initial!important;display:block!important;width:12px!important;height:12px!important;'
      + `border-radius:50%!important;background:${fill}!important;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)!important;cursor:default!important`
  }

  #activate(active: boolean): void {
    if (this.#active === active) return
    this.#active = active
    this.#paint()
  }

  #el(tag: string, style: string): HTMLElement {
    const el = this.#document.createElement(tag)
    if (style) el.setAttribute('style', style)
    return el
  }

  #button(kind: Button, style: string, path: SVGPathElement | null): HTMLElement {
    const b = this.#el('acde-frame-button', style)
    b.setAttribute('role', 'button')
    this.#buttons.push([kind, b, path])
    b.addEventListener('pointerdown', (event) => event.stopPropagation())
    b.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.#press(kind)
    })
    return b
  }

  #press(kind: Button): void {
    if (kind === 'close') void this.#window.close()
    else if (kind === 'minimize') void this.#window.minimize()
    else this.#toggle()
  }

  #dots(): HTMLElement {
    const row = this.#el('acde-frame-buttons', 'all:initial!important;display:flex!important;gap:8px!important;padding:0 12px!important;'
      + `width:${DefaultFrame.#DOTS}px!important;box-sizing:border-box!important;flex:none!important`)
    for (const kind of ['close', 'minimize', 'fullscreen'] as const) row.append(this.#button(kind, this.#dotStyle(kind), null))
    return row
  }

  #captions(): HTMLElement {
    const row = this.#el('acde-frame-buttons', 'all:initial!important;display:flex!important;height:100%!important;flex:none!important')
    const order = this.#look.side === 'left' ? (['close', 'fullscreen', 'minimize'] as const) : (['minimize', 'fullscreen', 'close'] as const)
    for (const kind of order) {
      const base = 'all:initial!important;display:flex!important;align-items:center!important;justify-content:center!important;'
        + `width:${DefaultFrame.#CAPTION}px!important;height:100%!important;cursor:default!important`
      const svg = this.#svg(kind === 'fullscreen' ? (this.#fullscreen ? 'restore' : 'maximize') : kind)
      const path = svg.firstChild as SVGPathElement
      const b = this.#button(kind, `${base};background:transparent!important`, path)
      b.append(svg)
      const hover = kind === 'close' ? '#c42b1c' : 'rgba(0,0,0,.06)'
      b.addEventListener('pointerenter', () => {
        b.setAttribute('style', `${base};background:${hover}!important`)
        if (kind === 'close') path.setAttribute('stroke', '#fff')
      })
      b.addEventListener('pointerleave', () => {
        b.setAttribute('style', `${base};background:transparent!important`)
        path.setAttribute('stroke', this.#colors().buttons)
      })
      row.append(b)
    }
    return row
  }

  #svg(glyph: keyof typeof GLYPHS): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = this.#document.createElementNS(ns, 'svg') as SVGSVGElement
    for (const [k, v] of [['width', '11'], ['height', '11'], ['viewBox', '0 0 11 11'], ['style', 'display:block!important;pointer-events:none!important']]) svg.setAttribute(k!, v!)
    const path = this.#document.createElementNS(ns, 'path') as SVGPathElement
    for (const [k, v] of [['d', GLYPHS[glyph]], ['fill', 'none'], ['stroke', this.#colors().buttons], ['stroke-width', '1']]) path.setAttribute(k!, v!)
    svg.append(path)
    return svg
  }

  #view(): Window & typeof globalThis {
    return this.#document.defaultView as Window & typeof globalThis
  }

  #labels(): void {
    const zh = /^zh\b/i.test(this.#view().navigator.language) ? 0 : 1
    for (const [kind, button] of this.#buttons) {
      const name = kind === 'fullscreen' && this.#look.style === 'glyphs' ? (this.#fullscreen ? 'restore' : 'maximize') : kind
      button.setAttribute('aria-label', DefaultFrame.#LABELS[name][zh])
    }
  }

  #attach(): void {
    const root = this.#document.documentElement
    if (!root) return
    if (this.#element.parentNode !== root || root.lastElementChild !== this.#element) root.append(this.#element)
    const style = root.getAttribute('style') ?? ''
    if (!style.includes(DefaultFrame.#ROOT)) root.setAttribute('style', `${style.replace(/;?\s*$/, ';')}${DefaultFrame.#ROOT}`.replace(/^;/, ''))
  }

  #toggle(): void {
    this.#fullscreen = !this.#fullscreen
    for (const [kind, , path] of this.#buttons) if (kind === 'fullscreen') path?.setAttribute('d', GLYPHS[this.#fullscreen ? 'restore' : 'maximize'])
    this.#labels()
    this.#window.requestMode(this.#fullscreen ? 'fullscreen' : 'free')
  }

  #hints(): void {
    const { innerWidth: w, innerHeight: h } = this.#view()
    const size = `${w}x${h}`
    if (size === this.#size || w <= 0 || h <= 0) return
    this.#size = size
    const hint = (x: number, y: number, width: number, height: number, edges: WindowEdge[] = []) => this.#window.setGrabHint({ x, y, width, height }, edges)
    const e = DefaultFrame.#EDGE, c = DefaultFrame.#CORNER
    const r = this.#look.style === 'glyphs' ? 3 * DefaultFrame.#CAPTION : DefaultFrame.#DOTS
    hint(0, 0, 0, 0)
    if (this.#look.side === 'left') hint(r, 0, w - r, DefaultFrame.HEIGHT)
    else hint(0, 0, w - r, DefaultFrame.HEIGHT)
    hint(0, 0, w, e, ['top'])
    hint(0, h - e, w, e, ['bottom'])
    hint(0, 0, e, h, ['left'])
    hint(w - e, 0, e, h, ['right'])
    hint(0, 0, c, c, ['top', 'left'])
    hint(w - c, 0, c, c, ['top', 'right'])
    hint(0, h - c, c, c, ['bottom', 'left'])
    hint(w - c, h - c, c, c, ['bottom', 'right'])
  }
}
