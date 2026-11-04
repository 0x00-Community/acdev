import type { WebInternals } from '@dopame/acde-dom'
import { PageSource } from './page'
import { WindowSelf } from './modules'
import type { IsolateDesk } from './desk'
import type { StorageFile } from './storage'
import { Level, Log } from './log'

interface WindowEvents {
  on(name: 'beforeclose', handler: () => unknown): () => boolean
}

export class AppPage {
  readonly #page: WebInternals
  readonly #desk: IsolateDesk
  readonly #name: string
  readonly #alerts: string[] = []
  #title: string | null = null
  #storage: StorageFile | null = null
  #leaving = false
  onTitle: (title: string) => void = () => {}

  constructor(page: WebInternals, desk: IsolateDesk, name: string, window: WindowEvents, storage: StorageFile | null) {
    this.#page = page
    this.#desk = desk
    this.#name = name
    this.#storage = storage
    const env = page.env
    env.close = () => {
      if (this.#leave()) this.#call(() => this.#desk.closeSelf())
    }
    env.reload = () => {
      if (this.#leave()) this.#call(() => this.#desk.reload(env.url))
    }
    env.navigate = (url, target) => this.#navigate(url, target)
    env.alert = (message) => this.#alert(message)
    window.on('beforeclose', () => void storage?.flush())
  }

  loaded(html: boolean): void {
    const document = this.#page.document as unknown as Document
    const window = this.#page.window as unknown as { MutationObserver: typeof MutationObserver }
    this.#title = html ? null : document.title
    this.#syncTitle()
    const observer = new window.MutationObserver(() => {
      this.#observeTitle(observer)
      this.#syncTitle()
    })
    this.#observeTitle(observer)
    if (html) this.#call(() => this.#desk.ready())
  }

  #observeTitle(observer: MutationObserver): void {
    const document = this.#page.document as unknown as Document
    observer.disconnect()
    if (document.head) observer.observe(document.head, { childList: true })
    const title = document.querySelector('title')
    if (!title) return
    observer.observe(title, { childList: true })
    for (const node of title.childNodes) if (node.nodeType === 3) observer.observe(node, { characterData: true })
  }

  #syncTitle(): void {
    const title = (this.#page.document as unknown as Document).title
    if (!title || title === this.#title) return
    this.#title = title
    this.onTitle(title)
    this.#call(() => this.#desk.setTitle(title))
  }

  #navigate(url: string, target: string): void {
    if (url.startsWith(`${PageSource.ORIGIN}/`)) {
      if (this.#leave()) this.#call(() => this.#desk.reload(url))
      return
    }
    if (/^https?:\/\//i.test(url)) return this.#call(() => this.#desk.openUrl(url))
    Log.write(Level.Info, 'acde_host', `[${this.#name}] does not follow ${url} (${target})`)
  }

  #leave(): boolean {
    if (!this.#leaving && !WindowSelf.unload(this.#page.window as never)) {
      Log.write(Level.Info, 'acde_host', `[${this.#name}] the page stays (beforeunload)`)
      return false
    }
    this.#leaving = true
    this.#storage?.flush()
    return true
  }

  #alert(message: string): void {
    Log.write(Level.Info, 'acde_host', `[${this.#name}] alert: ${message}`)
    this.#alerts.push(message)
    if (this.#alerts.length === 1) this.#showAlert()
  }

  #showAlert(): void {
    const message = this.#alerts[0]
    const document = this.#page.document as unknown as Document
    const parent = document.body ?? document.documentElement
    if (message === undefined || !parent) return
    const element = (tag: string, style: string, text?: string) => {
      const el = document.createElement(tag)
      el.setAttribute('style', style)
      if (text !== undefined) el.textContent = text
      return el
    }
    const overlay = element('div', 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);font:14px/1.5 system-ui,sans-serif')
    overlay.setAttribute('data-acde-alert', '')
    overlay.setAttribute('role', 'alertdialog')
    const box = element('div', 'box-sizing:border-box;display:flex;flex-direction:column;gap:14px;max-width:min(420px,calc(100% - 48px));min-width:240px;padding:20px 20px 14px;border-radius:12px;background:#fff;color:#1d1d1f;box-shadow:0 12px 40px rgba(0,0,0,.25)')
    const text = element('div', 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto', message)
    const ok = element('button', 'align-self:flex-end;min-width:72px;padding:6px 14px;border:0;border-radius:8px;background:#0a66ff;color:#fff;font:inherit;cursor:pointer', '确定')
    const dismiss = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      overlay.remove()
      this.#alerts.shift()
      this.#showAlert()
    }
    ok.addEventListener('click', dismiss)
    overlay.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key === 'Enter' || key === 'Escape' || key === ' ') dismiss(event)
    })
    box.append(text, ok)
    overlay.append(box)
    parent.append(overlay)
    ok.focus()
  }

  #call(call: () => unknown): void {
    try {
      void Promise.resolve(call()).catch((error: Error) => Log.write(Level.Warn, 'acde_host', `[${this.#name}] window: ${error.message}`))
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `[${this.#name}] window: ${(error as Error).message}`)
    }
  }
}
