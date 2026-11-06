import type { ConsoleEntry, RequestEntry, Web } from './acde.ts'

export class Format {
  static console(e: ConsoleEntry): string {
    const kind = e.kind === 'console' ? e.level : e.kind === 'error' ? 'ERROR' : 'REJECT'
    return `${String(e.seq).padStart(4)} ${kind.padEnd(6)} ${e.web}  ${e.text}`
  }

  static request(e: RequestEntry): string {
    const status = e.error !== null ? 'ERR' : e.status === null ? '...' : String(e.status)
    const size = e.responseBytes === null ? '' : ` ${e.responseBytes} B`
    const ms = e.ms === null ? '' : ` ${Math.round(e.ms)} ms`
    return `${String(e.seq).padStart(4)} ${e.method.padEnd(6)} ${status.padEnd(3)} ${e.url}  (${e.kind}${size}${ms}${e.error !== null ? `; ${e.error}` : ''}) ${e.web}`
  }

  static webs(webs: readonly Web[]): string {
    const rows = [['NAME', 'KIND', 'APP', 'WINDOW', 'TITLE'], ...webs.map((w) => [w.name, w.kind, w.app ?? '-', String(w.window), w.title ?? ''])]
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
    return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n')
  }
}
