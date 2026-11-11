import type { DomNative, WebInternals } from '@dopame/acde-dom'
import type { DomNode, DomRecord, DomSource } from './dom'

type Observer = { observe(target: unknown, options: object): void; disconnect(): void }
type InlineStyle = { readonly length: number; item(i: number): string; getPropertyValue(name: string): string; getPropertyPriority(name: string): string }
type ObserverClass = new (callback: (records: readonly DomRecord[]) => void) => Observer

const LOOKUP = Symbol.for('acde.devtools.node')

export class PageDom {
  static source(page: WebInternals, dom: DomNative): DomSource {
    return {
      document: () => page.document as unknown as DomNode,
      idOf: (node) => page.idOf(node),
      nodeOf: (id) => (page.nodeOf(id) as DomNode | null | undefined) ?? null,
      observe: (changed) => {
        const Observer = (page.window as unknown as { MutationObserver: ObserverClass }).MutationObserver
        const observer = new Observer(changed)
        observer.observe(page.document, { childList: true, subtree: true, attributes: true, characterData: true })
        return () => observer.disconnect()
      },
      computed: (node) => {
        const all = dom.computedStyleAll(page.idOf(node), '')
        const out: [string, string][] = []
        for (let i = 0; i + 1 < all.length; i += 2) out.push([all[i]!, all[i + 1]!])
        return out
      },
      inline: (node) => {
        const style = (node as { style?: InlineStyle }).style
        if (!style) return []
        const out: [string, string, boolean][] = []
        for (let i = 0; i < style.length; i++) {
          const name = style.item(i)
          out.push([name, style.getPropertyValue(name), style.getPropertyPriority(name) === 'important'])
        }
        return out
      },
      rect: (node) => {
        const [x = 0, y = 0, width = 0, height = 0] = dom.rect(page.idOf(node))
        return [x, y, width, height]
      },
      expose: (lookup) => {
        Object.defineProperty(page.window, LOOKUP, { value: lookup, configurable: true, enumerable: false, writable: false })
      },
    }
  }
}
