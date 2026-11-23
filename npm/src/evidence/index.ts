import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Format } from '../driver/format.ts'
import { slug } from '../paths.ts'
import type { ConsoleEntry, DevPage, RequestEntry, Shot, Snapshot, SnapshotOptions, WebList } from '../driver/types.ts'

export const BUDGET_MS = 20_000
export const DEFAULT_ROOT = '.acde/evidence'
export const RECENT_S = 120
const ENTRIES = 5000

export interface Scene {
  readonly closed: boolean
  screen(options: { readonly path?: string }): Promise<Shot>
  webList(): Promise<WebList>
  snapshot(options: SnapshotOptions): Promise<Snapshot>
  console(options: { readonly limit: number }): Promise<DevPage<ConsoleEntry>>
  network(options: { readonly limit: number }): Promise<DevPage<RequestEntry>>
}

export interface Capture {
  readonly label: string
  readonly since: Date
  readonly error?: unknown
  readonly output?: string | null
  readonly journal?: ((since: Date) => Promise<string>) | null
  readonly budgetMs?: number
  readonly now?: () => Date
}

export interface Item {
  readonly file: string
  readonly ok: boolean
  readonly ms: number
  readonly error?: string
}

export interface Kept {
  readonly dir: string
  readonly items: readonly Item[]
}

type Step = readonly [file: string, write: (path: string) => Promise<void>]

export function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '.$1Z')
}

export function folder(root: string, label: string, at: Date): string {
  mkdirSync(root, { recursive: true })
  const base = join(root, `${stamp(at)}-${slug(label) || 'evidence'}`)
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`
    try {
      mkdirSync(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

export function since(given: string | undefined, now: Date): Date {
  if (given === undefined) return new Date(now.getTime() - RECENT_S * 1000)
  const ago = /^(\d+)(s|m)$/.exec(given)
  if (ago) return new Date(now.getTime() - Number(ago[1]) * (ago[2] === 'm' ? 60_000 : 1000))
  const epoch = /^@(\d+(?:\.\d+)?)$/.exec(given)
  if (epoch) return new Date(Number(epoch[1]) * 1000)
  const at = new Date(given)
  if (Number.isNaN(at.getTime())) throw new Error(`--since ${given}: @<unix seconds>, an ISO time, or <n>s / <n>m ago`)
  return at
}

function text(path: string, body: string): void {
  writeFileSync(path, body.endsWith('\n') || body === '' ? body : `${body}\n`)
}

function said(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
}

function steps(scene: Scene | null, capture: Capture): Step[] {
  const all = { limit: ENTRIES }
  const plain: Step[] = [
    ...(capture.error !== undefined ? [['error.txt', async (p: string) => text(p, said(capture.error))] as const] : []),
    ...(capture.output ? [['output.log', async (p: string) => text(p, capture.output!)] as const] : []),
  ]
  const live: Step[] = scene && !scene.closed
    ? [
      ['screen.png', async (p) => void (await scene.screen({ path: p }))],
      ['webs.txt', async (p) => {
        const { webs, locked } = await scene.webList()
        text(p, Format.webs(webs, locked))
      }],
      ['snapshot.txt', async (p) => {
        const snapshot = await scene.snapshot({ all: true, offscreen: true })
        text(p, snapshot.text)
        text(p.replace(/snapshot\.txt$/, 'windows.json'), JSON.stringify(snapshot.windows, null, 2))
      }],
      ['console.txt', async (p) => text(p, (await scene.console(all)).entries.map(Format.console).join('\n'))],
      ['network.txt', async (p) => text(p, (await scene.network(all)).entries.map(Format.request).join('\n'))],
    ]
    : []
  const journal = capture.journal
  const guest: Step[] = journal ? [['journal.txt', async (p) => text(p, await journal(capture.since))]] : []
  return [...plain, ...live, ...guest]
}

async function within(ms: number, work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('not saved: no answer within the time left for the evidence')), Math.max(0, ms))
  })
  work.catch(() => undefined)
  try {
    await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

export async function keep(scene: Scene | null, capture: Capture & { readonly root: string }): Promise<Kept> {
  const at = (capture.now ?? (() => new Date()))()
  return await write(scene, capture, folder(capture.root, capture.label, at), at)
}

export async function write(scene: Scene | null, capture: Capture, dir: string, at = new Date()): Promise<Kept> {
  mkdirSync(dir, { recursive: true })
  const until = Date.now() + (capture.budgetMs ?? BUDGET_MS)
  const items: Item[] = []
  for (const [file, take] of steps(scene, capture)) {
    const started = Date.now()
    try {
      await within(until - started, take(join(dir, file)))
      items.push({ file, ok: true, ms: Date.now() - started })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      text(join(dir, `${file}.error.txt`), why)
      items.push({ file, ok: false, ms: Date.now() - started, error: why })
    }
  }
  const manifest = { label: capture.label, at: at.toISOString(), since: capture.since.toISOString(), items }
  text(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, items }
}

export function summary(kept: Kept): string {
  const saved = kept.items.filter((i) => i.ok).map((i) => i.file)
  const missed = kept.items.filter((i) => !i.ok).map((i) => `${i.file} (${i.error})`)
  return `saved ${saved.join(', ') || 'nothing'} in ${kept.dir}${missed.length ? `; not saved: ${missed.join('; ')}` : ''}`
}
