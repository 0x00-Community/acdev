import type { InspectNode } from '@acde/api'
import type { PermissionDecision, PermissionPrompt } from './acde.ts'
import type { ConsoleEntry, Permissions, QueryResult, RequestEntry, Snapshot, Web } from './acde.ts'
import { Locator } from './locator.ts'

export class Format {
  static console(e: ConsoleEntry): string {
    const kind = e.kind === 'console' ? e.level : e.kind === 'error' ? 'ERROR' : 'REJECT'
    return `${String(e.seq).padStart(4)} ${kind.padEnd(6)} ${e.web}  ${e.text}`
  }

  static request(e: RequestEntry): string {
    const status = e.error !== null ? 'ERR' : e.status === null ? '...' : String(e.status)
    const size = e.responseBytes === null ? '' : ` ${e.responseBytes} B`
    const ms = e.ms === null ? '' : ` ${Math.round(e.ms)} ms`
    const about = `${e.kind}${e.mocked ? ', mocked' : ''}${size}${ms}${e.error !== null ? `; ${e.error}` : ''}`
    return `${String(e.seq).padStart(4)} ${e.method.padEnd(6)} ${status.padEnd(3)} ${e.url}  (${about}) ${e.web}`
  }

  static matches(found: QueryResult, selector: string): string {
    if (!found.count) return `nothing in ${found.window} matches ${JSON.stringify(selector)}`
    const lines = found.nodes.map((n) => `- ${Locator.line(n, false)} <${n.tag}>${n.visible ? '' : ' [hidden]'}`)
    const more = found.count > found.nodes.length ? `\n(${found.count - found.nodes.length} more not listed)` : ''
    return `${found.count} in ${found.window}:\n${lines.join('\n')}${more}`
  }

  static prompt(prompt: PermissionPrompt): string {
    return `${prompt.id}  ${prompt.app}  ${prompt.capability}  (${prompt.reason})`
  }

  static decision(decision: PermissionDecision): string {
    return `${decision.app}  ${decision.capability}  ${decision.decision}`
  }

  static permissions(permissions: Permissions): string {
    const block = (name: string, lines: readonly string[]) =>
      lines.length ? `${name}:\n${lines.map((line) => `  ${line}`).join('\n')}` : `${name}: none`
    const pending = block('pending', permissions.pending.map(Format.prompt))
    return `${pending}\n${block('decisions', permissions.decisions.map(Format.decision))}`
  }

  static answered(prompt: PermissionPrompt, allow: boolean): string {
    return `${allow ? 'allowed' : 'denied'} ${prompt.app} ${prompt.capability} (prompt ${prompt.id})`
  }

  static waiting(prompt: PermissionPrompt, how: string): string {
    return `${prompt.app} waits for approval of ${prompt.capability}: ${how}`
  }

  static webs(webs: readonly Web[], locked: boolean | null = null): string {
    const marked = webs.some((w) => w.lock !== undefined)
    const rows = [
      ['NAME', 'KIND', 'APP', 'WINDOW', ...(marked ? ['LOCK'] : []), 'TITLE'],
      ...webs.map((w) => [w.name, w.kind, w.app ?? '-', String(w.window), ...(marked ? [w.lock ? 'lock' : '-'] : []), Format.#title(w)]),
    ]
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
    const row = (r: string[]) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')
    const table = rows.map((r) => row(r).trimEnd()).join('\n')
    return locked === null ? table : `${table}\nlocked: ${locked ? 'yes (the lock page is up)' : 'no'}`
  }

  static readonly STALLED = '(not answering)'

  static #title(web: Web): string {
    return web.stalled ? Format.STALLED : (web.title ?? '')
  }

  static node(n: InspectNode): string {
    return Locator.line(n)
  }

  static found(snapshot: Snapshot, text: string): string[] {
    const needle = text.trim().toLowerCase()
    const hit = (n: InspectNode) => [n.name, n.value].some((s) => s?.toLowerCase().includes(needle))
    const lines: string[] = []
    for (const [ref, nodes] of Object.entries(snapshot.trees)) {
      const matches: string[] = []
      const walk = (list: readonly InspectNode[], named: InspectNode | null) => {
        for (const n of list) {
          if (hit(n)) matches.push(`- ${Locator.line(n)}${named ? `  in ${Locator.line(named)}` : ''}`)
          walk(n.children ?? [], n.name ? n : named)
        }
      }
      walk(nodes, null)
      if (!matches.length) continue
      const window = snapshot.windows.find((w) => w.ref === ref)
      const what = window?.kind === 'desktop' ? 'desktop' : (window?.app ?? window?.kind ?? '')
      const title = window?.title ? ` ${JSON.stringify(window.title)}` : ''
      lines.push(`${ref} ${what}${title}:`.replace(/ :$/, ':'), ...matches)
    }
    return lines
  }
}
