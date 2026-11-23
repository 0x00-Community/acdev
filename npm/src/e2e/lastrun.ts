import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const FILE = 'last-run.json'

export interface Failed {
  readonly file: string
  readonly test: string
}

export interface LastRun {
  readonly status: 'passed' | 'failed'
  readonly failed: readonly Failed[]
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return ENTITIES[name!] ?? whole
  })
}

export function failedIn(junit: string): string[] {
  const names: string[] = []
  for (const found of junit.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!found[3]?.includes('<failure')) continue
    const name = /\bname="([^"]*)"/.exec(found[1]!)
    if (name) names.push(unescapeXml(name[1]!))
  }
  return names
}

export function write(root: string, failed: readonly Failed[]): void {
  const run: LastRun = { status: failed.length ? 'failed' : 'passed', failed }
  writeFileSync(join(root, FILE), `${JSON.stringify(run, null, 2)}\n`)
}

export function read(root: string): LastRun | null {
  const path = join(root, FILE)
  if (!existsSync(path)) return null
  try {
    const run = JSON.parse(readFileSync(path, 'utf8')) as Partial<LastRun>
    const failed = Array.isArray(run.failed) ? run.failed.filter((f) => typeof f?.file === 'string' && typeof f?.test === 'string') : []
    return { status: failed.length ? 'failed' : 'passed', failed }
  } catch {
    return null
  }
}

export function pattern(tests: readonly string[]): string {
  const escaped = [...new Set(tests)].map((test) => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return `(?:${escaped.join('|')})$`
}

export function failedInReport(report: string): string[] {
  try {
    return failedIn(readFileSync(report, 'utf8'))
  } catch {
    return []
  }
}
