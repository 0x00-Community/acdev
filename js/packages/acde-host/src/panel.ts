import type { ImePanelEvent } from './ime'

interface ImePanelActions {
  select(index: number): void
  page(next: boolean): void
}

export class ImePanel {
  static readonly #STYLE = [
    'position:fixed', 'z-index:2147483647', 'display:flex', 'flex-direction:column', 'gap:4px', 'padding:6px 8px',
    'border-radius:12px', 'background:var(--acde-ime-bg, rgba(255, 255, 255, .94))', 'color:var(--acde-ime-fg, #1D1D1F)',
    'box-shadow:0 0 0 .5px rgba(0, 0, 0, .12), 0 10px 30px -8px rgba(40, 20, 70, .35)', 'font:15px/1.4 "Noto Sans CJK SC", sans-serif',
    'white-space:nowrap', 'pointer-events:auto', 'user-select:none',
  ].join(';')
  readonly #document: Document
  readonly #actions: ImePanelActions
  #element: HTMLElement | null = null

  constructor(document: Document, actions: ImePanelActions) {
    this.#document = document
    this.#actions = actions
  }

  get shown(): boolean {
    return !!this.#element?.isConnected
  }

  show(event: ImePanelEvent, caret: { x: number; y: number; width: number; height: number }): void {
    if (!event.preedit && !event.auxUp && !event.auxDown && event.candidates.length === 0) return this.hide()
    const panel = (this.#element ??= this.#create())
    const doc = this.#document
    const line = (cls: string, text: string) => {
      const e = doc.createElement('div')
      e.className = cls
      e.textContent = text
      e.setAttribute('style', 'font-size:13px;color:var(--acde-ime-dim, #6E6977)')
      return e
    }
    const parts: HTMLElement[] = []
    const top = [event.auxUp, event.preedit].filter(Boolean).join(' ')
    if (top) parts.push(line('ime-aux', top))
    if (event.candidates.length) {
      const row = doc.createElement('div')
      row.className = 'ime-list'
      const vertical = event.layout === 'vertical'
      row.setAttribute('style', `display:flex;flex-direction:${vertical ? 'column' : 'row'};gap:2px;align-items:${vertical ? 'stretch' : 'center'}`)
      event.candidates.forEach((candidate, index) => {
        const on = index === event.highlight
        const item = doc.createElement('div')
        item.className = on ? 'ime-cand on' : 'ime-cand'
        item.dataset['index'] = String(index)
        item.setAttribute('style', `display:flex;gap:4px;align-items:baseline;padding:2px 8px;border-radius:7px;cursor:default;${on ? 'background:var(--acde-ime-accent, #8B5CF6);color:#fff' : ''}`)
        const label = doc.createElement('span')
        label.className = 'ime-label'
        label.textContent = candidate.label.replace(/[.．、]\s*$/, '')
        label.setAttribute('style', `font-size:12px;${on ? 'opacity:.8' : 'color:var(--acde-ime-dim, #6E6977)'}`)
        const text = doc.createElement('span')
        text.className = 'ime-text'
        text.textContent = candidate.text
        item.append(label, text)
        row.append(item)
      })
      if (event.hasPrev || event.hasNext) {
        for (const [next, glyph, can] of [[false, '‹', event.hasPrev], [true, '›', event.hasNext]] as const) {
          const arrow = doc.createElement('div')
          arrow.className = 'ime-page'
          arrow.dataset['page'] = next ? 'next' : 'prev'
          arrow.textContent = glyph
          arrow.setAttribute('style', `padding:0 6px;font-size:17px;${can ? '' : 'opacity:.3'}`)
          row.append(arrow)
        }
      }
      parts.push(row)
    }
    if (event.auxDown) parts.push(line('ime-aux down', event.auxDown))
    panel.replaceChildren(...parts)
    const view = doc.defaultView
    const height = (view?.innerHeight ?? 0) || 800
    const below = caret.y + caret.height + 6
    const style = below + 72 > height ? `left:${caret.x - 8}px;bottom:${height - caret.y + 6}px` : `left:${caret.x - 8}px;top:${below}px`
    panel.setAttribute('style', `${ImePanel.#STYLE};${style}`)
    if (!panel.isConnected) doc.body.append(panel)
  }

  hide(): void {
    this.#element?.remove()
  }

  #create(): HTMLElement {
    const panel = this.#document.createElement('div')
    panel.setAttribute('data-acde-ime-panel', '')
    panel.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      const target = (event.target as Element | null)?.closest?.('[data-index], [data-page]') as HTMLElement | null
      if (!target) return
      if (target.dataset['index'] !== undefined) this.#actions.select(Number(target.dataset['index']))
      else this.#actions.page(target.dataset['page'] === 'next')
    })
    panel.addEventListener('mousedown', (event) => event.preventDefault())
    return panel
  }
}
