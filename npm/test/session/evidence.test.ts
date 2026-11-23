import { describe, expect as check, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Evidence from '../../src/evidence/index.ts'

const at = new Date('2026-11-23T14:05:06.789Z')

function root(): string {
  return mkdtempSync(join(tmpdir(), 'acdev-evidence-'))
}

function scene(overrides: Partial<Evidence.Scene> = {}): Evidence.Scene {
  return {
    closed: false,
    screen: async ({ path }) => {
      writeFileSync(path!, 'png')
      return { path: path!, width: 1, height: 1 } as never
    },
    webList: async () => ({ webs: [], locked: null }) as never,
    snapshot: async () => ({ text: '- desktop [w0]', windows: [{ ref: 'w0' }], trees: {} }) as never,
    console: async () => ({ entries: [], next: 1 }) as never,
    network: async () => ({ entries: [], next: 1 }) as never,
    ...overrides,
  }
}

describe('evidence of a failure', () => {
  test('every capture gets a folder of its own, named by its UTC time and label, and none is written over', () => {
    const dir = root()
    try {
      const first = Evidence.folder(dir, 'drag fails', at)
      const second = Evidence.folder(dir, 'drag fails', at)
      check(first.endsWith('20261123T140506.789Z-drag-fails')).toBe(true)
      check(second).toBe(`${first}-2`)
      check(Evidence.folder(dir, '', at).endsWith('-evidence')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the journal starts at an epoch, an ISO time or some time ago, and two minutes ago without one', () => {
    check(Evidence.since('@1764000000', at).getTime()).toBe(1764000000_000)
    check(Evidence.since('5m', at).getTime()).toBe(at.getTime() - 300_000)
    check(Evidence.since('30s', at).getTime()).toBe(at.getTime() - 30_000)
    check(Evidence.since('2026-11-23T14:00:00Z', at).toISOString()).toBe('2026-11-23T14:00:00.000Z')
    check(Evidence.since(undefined, at).getTime()).toBe(at.getTime() - Evidence.RECENT_S * 1000)
    check(() => Evidence.since('yesterday', at)).toThrow('--since yesterday')
  })

  test('what answers is saved, what fails is named beside it and in the manifest, and the guest journal comes along', async () => {
    const dir = root()
    try {
      const failing = scene({ network: async () => Promise.reject(new Error('the page went away')) })
      const journal = async (since: Date) => `journal since ${since.toISOString()}`
      const kept = await Evidence.keep(failing, { root: dir, label: 'files', since: at, error: new Error('check failed'), journal, now: () => at })
      const files = readdirSync(kept.dir).sort()
      check(files).toEqual([
        'console.txt', 'error.txt', 'journal.txt', 'manifest.json', 'network.txt.error.txt', 'screen.png', 'snapshot.txt', 'webs.txt',
        'windows.json',
      ])
      check(readFileSync(join(kept.dir, 'journal.txt'), 'utf8')).toBe(`journal since ${at.toISOString()}\n`)
      const manifest = JSON.parse(readFileSync(join(kept.dir, 'manifest.json'), 'utf8'))
      check(manifest.since).toBe(at.toISOString())
      check(manifest.items.find((i: Evidence.Item) => i.file === 'network.txt')).toMatchObject({ ok: false, error: 'the page went away' })
      check(Evidence.summary(kept)).toContain('not saved: network.txt (the page went away)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a session that is gone or never answers still leaves the reason and the journal within the time given', async () => {
    const dir = root()
    try {
      const gone = await Evidence.keep(null, { root: dir, label: 'gone', since: at, error: new Error('no session'), journal: async () => 'j' })
      check(readdirSync(gone.dir).sort()).toEqual(['error.txt', 'journal.txt', 'manifest.json'])
      const stuck = scene({ webList: () => new Promise(() => {}) })
      const late = await Evidence.keep(stuck, { root: dir, label: 'stuck', since: at, budgetMs: 50 })
      check(late.items.find((i) => i.file === 'webs.txt')?.ok).toBe(false)
      check(existsSync(join(late.dir, 'webs.txt.error.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
