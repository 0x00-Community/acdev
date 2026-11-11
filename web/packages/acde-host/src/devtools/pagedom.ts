import type { WebInternals } from '@dopame/acde-dom'
import type { DomNode, DomRecord, DomSource } from './dom'

type Observer = { observe(target: unknown, options: object): void; disconnect(): void }
type ObserverClass = new (callback: (records: readonly DomRecord[]) => void) => Observer

const LOOKUP = Symbol.for('acde.devtools.node')

export class PageDom {
  static source(page: WebInternals): DomSource {
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
      expose: (lookup) => {
        Object.defineProperty(page.window, LOOKUP, { value: lookup, configurable: true, enumerable: false, writable: false })
      },
    }
  }
}
