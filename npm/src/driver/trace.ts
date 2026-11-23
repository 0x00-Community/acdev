import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TraceStep {
  readonly index: number
  readonly title: string
  readonly at: number
  readonly ms: number
  readonly ok: boolean
  readonly text: string
  readonly screen: string | null
}

export interface TraceShooter {
  readonly closed: boolean
  screen(): Promise<{ readonly png: Buffer }>
}

export class Trace {
  static readonly TEXT_MAX = 4000

  screenshots = false
  onStep: ((step: TraceStep) => void) | null = null
  readonly #steps: TraceStep[] = []
  readonly #shots = new Map<string, Buffer>()
  readonly #started = Date.now()
  readonly #shooter: TraceShooter
  #depth = 0

  constructor(shooter: TraceShooter) {
    this.#shooter = shooter
  }

  get steps(): readonly TraceStep[] {
    return this.#steps
  }

  async step<T>(title: string, run: () => Promise<T>, said?: (value: T) => string): Promise<T> {
    if (this.#depth > 0) return run()
    this.#depth++
    const at = Date.now()
    let ok = true
    let text = ''
    try {
      const value = await run()
      text = said ? said(value) : ''
      return value
    } catch (error) {
      ok = false
      text = (error as Error)?.message ?? String(error)
      throw error
    } finally {
      this.#depth--
      await this.#record(title, at, ok, text)
    }
  }

  text(): string {
    if (!this.#steps.length) return '(no steps)'
    return this.#steps
      .map((s) => {
        const head = `${String(s.index).padStart(3)} ${s.ok ? 'ok  ' : 'FAIL'} +${((s.at - this.#started) / 1000).toFixed(2)}s ${String(s.ms).padStart(5)} ms  ${s.title}`
        const body = s.text ? `\n${s.text.split('\n').map((line) => `       ${line}`).join('\n')}` : ''
        return head + body
      })
      .join('\n')
  }

  write(dir: string, title: string): string[] {
    mkdirSync(dir, { recursive: true })
    const wrote = ['trace.txt']
    writeFileSync(join(dir, 'trace.txt'), `${this.text()}\n`)
    if (!this.#shots.size) return wrote
    const shots = join(dir, 'trace')
    mkdirSync(shots, { recursive: true })
    for (const [name, png] of this.#shots) writeFileSync(join(shots, name), png)
    writeFileSync(join(dir, 'trace.html'), Trace.html(title, this.#steps, this.#started))
    wrote.push('trace.html', 'trace/')
    return wrote
  }

  async #record(title: string, at: number, ok: boolean, text: string): Promise<void> {
    const index = this.#steps.length + 1
    let screen: string | null = null
    if (this.screenshots && !this.#shooter.closed) {
      try {
        screen = `${String(index).padStart(3, '0')}.png`
        this.#shots.set(screen, (await this.#shooter.screen()).png)
      } catch {
        screen = null
      }
    }
    const step = { index, title, at, ms: Date.now() - at, ok, text: text.length > Trace.TEXT_MAX ? `${text.slice(0, Trace.TEXT_MAX)}…` : text, screen }
    this.#steps.push(step)
    this.onStep?.(step)
  }

  static html(title: string, steps: readonly TraceStep[], started: number): string {
    const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    const items = steps
      .map(
        (s) =>
          `<li class="${s.ok ? 'ok' : 'fail'}" data-screen="${s.screen ? `trace/${s.screen}` : ''}" tabindex="0"><span class="n">${s.index}</span><span class="t">${escape(s.title)}</span><span class="ms">+${((s.at - started) / 1000).toFixed(2)}s · ${s.ms} ms</span>${s.text ? `<pre>${escape(s.text)}</pre>` : ''}</li>`,
      )
      .join('\n')
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace: ${escape(title)}</title>
<style>
:root { --bg: #f7f7f8; --panel: #ffffff; --ink: #1d1d22; --muted: #6b6b76; --line: #e3e3e8; --ok: #1f7a4d; --fail: #c0362c; --pick: #e9effd; }
@media (prefers-color-scheme: dark) { :root { --bg: #16161a; --panel: #1f1f24; --ink: #ececf1; --muted: #9a9aa6; --line: #2e2e36; --ok: #4cc38a; --fail: #ff6b5f; --pick: #263252; } }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; display: grid; grid-template-columns: minmax(280px, 38%) 1fr; height: 100vh }
header { grid-column: 1 / -1; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); font-weight: 600 }
ol { margin: 0; padding: 0; list-style: none; overflow: auto; border-right: 1px solid var(--line); background: var(--panel) }
li { padding: 8px 12px; border-bottom: 1px solid var(--line); cursor: pointer; display: grid; grid-template-columns: 2.4em 1fr; gap: 2px 6px }
li:focus, li.picked { outline: none; background: var(--pick) }
.n { color: var(--muted); grid-row: span 2 }
li.ok .n::after { content: ' ✓'; color: var(--ok) }
li.fail .n::after { content: ' ✗'; color: var(--fail) }
li.fail .t { color: var(--fail) }
.t { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word }
.ms { color: var(--muted); font-size: 12px }
pre { grid-column: 2; margin: 4px 0 0; white-space: pre-wrap; color: var(--muted); font-size: 12px; max-height: 12em; overflow: auto }
main { overflow: auto; padding: 16px; display: flex; align-items: flex-start; justify-content: center }
main img { max-width: 100%; border: 1px solid var(--line); background: var(--panel) }
main p { color: var(--muted) }
@media (max-width: 720px) { body { grid-template-columns: 1fr; grid-template-rows: auto 50vh 1fr } ol { border-right: 0 } }
</style>
</head>
<body>
<header>${escape(title)}</header>
<ol>
${items}
</ol>
<main><p>Pick a step to see the screen after it.</p></main>
<script>
const main = document.querySelector('main')
const show = (li) => {
  for (const other of document.querySelectorAll('li.picked')) other.classList.remove('picked')
  li.classList.add('picked')
  const src = li.dataset.screen
  main.replaceChildren()
  if (src) { const img = document.createElement('img'); img.src = src; img.alt = 'screen after step ' + li.querySelector('.n').textContent; main.append(img) }
  else { const p = document.createElement('p'); p.textContent = 'No screenshot for this step.'; main.append(p) }
}
for (const li of document.querySelectorAll('li')) {
  li.addEventListener('click', () => show(li))
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(li); if (e.key === 'ArrowDown') li.nextElementSibling?.focus(); if (e.key === 'ArrowUp') li.previousElementSibling?.focus() })
}
const last = document.querySelector('li:last-child')
if (last) show(last)
</script>
</body>
</html>
`
  }
}
