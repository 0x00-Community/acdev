import type { WindowEdge, WindowMode, WindowRect } from '@dopame/acde-api'

interface FrameWindow {
  close(): unknown
  minimize(): unknown
  requestMode(mode: WindowMode): void
  setGrabHint(rect: WindowRect, edges?: readonly WindowEdge[]): void
}

type FrameButton = 'close' | 'minimize' | 'fullscreen'

interface FramePage {
  readonly document: Document
  readonly window: { innerWidth: number; innerHeight: number; navigator: { language: string }; MutationObserver: typeof MutationObserver; addEventListener(type: string, fn: () => void): void }
}

export class WindowFrame {
  static readonly HEIGHT = 32
  static readonly #EDGE = 4
  static readonly #CORNER = 10
  static readonly #BUTTONS = 76
  static readonly #STYLE = `all:initial!important;position:fixed!important;z-index:2147483646!important;left:0!important;top:0!important;right:0!important;height:${WindowFrame.HEIGHT}px!important;display:flex!important;align-items:center!important;box-sizing:border-box!important;border-bottom:1px solid rgba(0,0,0,.08)!important;background:#f4f2f7!important;font:600 13px/1 system-ui,sans-serif!important;color:#3a3542!important;user-select:none!important;cursor:default!important`
  static readonly #LABELS = { close: ['关闭', 'Close'], minimize: ['最小化', 'Minimize'], fullscreen: ['全屏', 'Full Screen'] } as const
  static readonly #ROOT = `box-sizing:border-box!important;padding-top:${WindowFrame.HEIGHT}px!important;height:100%!important`

  readonly #page: FramePage
  readonly #window: FrameWindow
  readonly #element: HTMLElement
  readonly #title: HTMLElement
  readonly #buttons: [FrameButton, HTMLElement][] = []
  #fullscreen = false
  #size = ''

  constructor(page: FramePage, window: FrameWindow, title: string) {
    this.#page = page
    this.#window = window
    const document = page.document
    const element = (tag: string, style: string) => {
      const el = document.createElement(tag)
      el.setAttribute('style', style)
      return el
    }
    this.#element = element('acde-frame', WindowFrame.#STYLE)
    this.#element.setAttribute('data-acde-frame', '')
    const buttons = element('acde-frame-buttons', `all:initial!important;display:flex!important;gap:8px!important;padding:0 12px!important;width:${WindowFrame.#BUTTONS}px!important;box-sizing:border-box!important`)
    const button = (color: string, kind: FrameButton, action: () => void) => {
      const b = element('acde-frame-button', `all:initial!important;display:block!important;width:12px!important;height:12px!important;border-radius:50%!important;background:${color}!important;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)!important;cursor:default!important`)
      b.setAttribute('role', 'button')
      this.#buttons.push([kind, b])
      b.addEventListener('pointerdown', (event) => event.stopPropagation())
      b.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        action()
      })
      return b
    }
    buttons.append(
      button('#ff5f57', 'close', () => void this.#window.close()),
      button('#febc2e', 'minimize', () => void this.#window.minimize()),
      button('#28c840', 'fullscreen', () => this.#toggle()),
    )
    this.#title = element('acde-frame-title', `all:initial!important;flex:1!important;margin-right:${WindowFrame.#BUTTONS}px!important;text-align:center!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font:inherit!important;color:inherit!important`)
    this.#element.append(buttons, this.#title)
    this.title(title)
    this.#labels()
  }

  install(): void {
    const { document, window } = this.#page
    this.#attach()
    new window.MutationObserver(() => this.#attach()).observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', () => this.#hints())
    window.addEventListener('languagechange', () => this.#labels())
    this.#hints()
  }

  #labels(): void {
    const zh = /^zh\b/i.test(this.#page.window.navigator.language)
    for (const [kind, button] of this.#buttons) button.setAttribute('aria-label', WindowFrame.#LABELS[kind][zh ? 0 : 1])
  }

  title(text: string): void {
    if (this.#title.textContent !== text) this.#title.textContent = text
  }

  #attach(): void {
    const root = this.#page.document.documentElement
    if (!root) return
    if (this.#element.parentNode !== root || root.lastElementChild !== this.#element) root.append(this.#element)
    const style = root.getAttribute('style') ?? ''
    if (!style.includes(WindowFrame.#ROOT)) root.setAttribute('style', `${style.replace(/;?\s*$/, ';')}${WindowFrame.#ROOT}`.replace(/^;/, ''))
  }

  #toggle(): void {
    this.#fullscreen = !this.#fullscreen
    this.#window.requestMode(this.#fullscreen ? 'fullscreen' : 'free')
  }

  #hints(): void {
    const { innerWidth: w, innerHeight: h } = this.#page.window
    const size = `${w}x${h}`
    if (size === this.#size || w <= 0 || h <= 0) return
    this.#size = size
    const hint = (x: number, y: number, width: number, height: number, edges: WindowEdge[] = []) => this.#window.setGrabHint({ x, y, width, height }, edges)
    const e = WindowFrame.#EDGE, c = WindowFrame.#CORNER
    hint(0, 0, 0, 0)
    hint(WindowFrame.#BUTTONS, 0, w - WindowFrame.#BUTTONS, WindowFrame.HEIGHT)
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
