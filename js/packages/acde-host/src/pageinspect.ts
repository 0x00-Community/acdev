import type { DomNative, WebInternals } from '@dopame/acde-dom'
import type { Host } from './host'

export interface PageNode {
  readonly id: number
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly states?: readonly string[]
  readonly level?: number
  readonly rect: readonly [number, number, number, number]
  readonly more?: number
  readonly children?: readonly PageNode[]
}

export interface PageTree {
  readonly hidden: number
  readonly truncated: boolean
  readonly nodes: readonly PageNode[]
  readonly width: number
  readonly height: number
}

export type PagePoint = { readonly x: number; readonly y: number } | { readonly error: string }

type Field = HTMLInputElement | HTMLTextAreaElement

export class PageInspect {
  static readonly LIMIT = 600

  constructor(
    readonly page: WebInternals,
    readonly dom: DomNative,
    readonly host: Host,
  ) {}

  serve(method: string, args: unknown[]): unknown {
    switch (method) {
      case 'tree':
        return this.tree(Number(args[0] ?? -1), Number(args[1] ?? PageInspect.LIMIT))
      case 'point':
        return this.point(Number(args[0]))
      case 'type':
        return this.type(Number(args[0]), String(args[1] ?? ''), args[2] === true)
      case 'focus':
        return this.focus(Number(args[0]))
      case 'settle':
        return this.settle(Number(args[0]) || 200, Number(args[1]) || 3000)
      default:
        throw new Error(`inspect has no ${method}`)
    }
  }

  tree(root: number, limit: number): PageTree {
    if (!this.dom.semantics) throw new Error('this acde has no semantics')
    const parsed = JSON.parse(this.dom.semantics(root < 0 ? -1 : root, limit)) as Omit<PageTree, 'width' | 'height'>
    const window = this.page.window as unknown as Window
    return { ...parsed, width: window.innerWidth, height: window.innerHeight }
  }

  point(id: number): PagePoint {
    const element = this.#element(id)
    if (!element) return { error: `元素 ${id} 不在了` }
    const window = this.page.window as unknown as Window
    let rect = this.#rect(element)
    if (!rect) return { error: '元素没有显示出来' }
    const inside = (r: DOMRect) => r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight
    if (!inside(rect) || !this.#hits(element, rect)) {
      element.scrollIntoView({ block: 'center', inline: 'center' })
      rect = this.#rect(element)
      if (!rect) return { error: '元素没有显示出来' }
    }
    const left = Math.max(rect.left, 0)
    const top = Math.max(rect.top, 0)
    const right = Math.min(rect.right, window.innerWidth)
    const bottom = Math.min(rect.bottom, window.innerHeight)
    if (right <= left || bottom <= top) return { error: '元素在可见范围之外' }
    const points: [number, number][] = [
      [(left + right) / 2, (top + bottom) / 2],
      [left + (right - left) * 0.25, (top + bottom) / 2],
      [left + (right - left) * 0.75, (top + bottom) / 2],
      [(left + right) / 2, top + (bottom - top) * 0.25],
      [(left + right) / 2, top + (bottom - top) * 0.75],
      [left + 2, top + 2],
    ]
    let covered = -1
    for (const [x, y] of points) {
      const hit = this.dom.hitTest(x, y)
      if (hit < 0) continue
      if (this.#within(hit, element)) return { x: Math.round(x), y: Math.round(y) }
      covered = hit
    }
    if (covered < 0) return { x: Math.round(points[0]![0]), y: Math.round(points[0]![1]) }
    return { error: `被别的元素挡住了: ${this.#describe(covered)}` }
  }

  type(id: number, text: string, replace: boolean): { value: string | null } {
    const element = this.#element(id)
    if (!element) throw new Error(`元素 ${id} 不在了`)
    const target = this.#editable(element)
    if (!target) throw new Error('这个元素不能输入文字')
    const document = this.page.document as unknown as Document
    if (document.activeElement !== target) target.focus()
    if (replace) {
      if ('select' in target && typeof (target as Field).select === 'function') (target as Field).select()
      else {
        const selection = (this.page.window as unknown as Window).getSelection()
        selection?.selectAllChildren(target)
      }
      if (!text) this.page.editing.insertText(target as never, '', 'deleteContentBackward')
    }
    if (text) this.host.insertText(text)
    const value = 'value' in target ? String((target as Field).value) : (target.textContent ?? '')
    return { value: (target as Field).type === 'password' ? '•••' : value.slice(0, 200) }
  }

  focus(id: number): boolean {
    const element = this.#element(id)
    if (!element) throw new Error(`元素 ${id} 不在了`)
    element.focus()
    return (this.page.document as unknown as Document).activeElement === element
  }

  settle(quiet: number, max: number): Promise<number> {
    const window = this.page.window as unknown as typeof globalThis
    const document = this.page.document as unknown as Document
    const started = Date.now()
    let last = started
    const observer = new window.MutationObserver(() => (last = Date.now()))
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    return new Promise((resolve) => {
      const check = () => {
        const now = Date.now()
        if (now - last >= quiet || now - started >= max) {
          observer.disconnect()
          return resolve(now - started)
        }
        setTimeout(check, Math.min(quiet - (now - last), max - (now - started)))
      }
      setTimeout(check, quiet)
    })
  }

  #element(id: number): HTMLElement | null {
    let node = this.page.nodeOf(id) as Node | null
    while (node && node.nodeType !== 1) node = node.parentNode
    return (node as HTMLElement | null) ?? null
  }

  #rect(element: Element): DOMRect | null {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? rect : null
  }

  #hits(element: Element, rect: DOMRect): boolean {
    const hit = this.dom.hitTest(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit >= 0 && this.#within(hit, element)
  }

  #within(hit: number, element: Element): boolean {
    const node = this.page.nodeOf(hit) as Node | null
    return !!node && (node === element || element.contains(node))
  }

  #describe(id: number): string {
    const node = this.page.nodeOf(id) as Element | null
    if (!node || node.nodeType !== 1) return `#${id}`
    const label = node.getAttribute('aria-label') ?? (node.textContent ?? '').trim().slice(0, 40)
    return `<${node.localName}${label ? ` "${label}"` : ''}> (${id})`
  }

  #editable(element: HTMLElement): HTMLElement | null {
    const document = this.page.document as unknown as Document
    for (let e: HTMLElement | null = element; e && e !== document.body; e = e.parentElement) {
      if (e instanceof (this.page.window as unknown as typeof globalThis).HTMLTextAreaElement) return e
      if (e instanceof (this.page.window as unknown as typeof globalThis).HTMLInputElement) return e
      if (e.isContentEditable) return e
    }
    const inner = element.querySelector<HTMLElement>('input, textarea, [contenteditable]:not([contenteditable="false"])')
    return inner
  }
}
