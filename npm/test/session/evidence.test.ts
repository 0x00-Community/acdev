import { describe, expect as check, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Evidence from '../../src/evidence/index.ts'
import { Png } from '../../src/driver/png.ts'
import { BLOCK_RGBA, PLACEHOLDER } from '../../src/redaction/index.ts'
import { dropEmpty, KEEP_RUNS, newRun, prune } from '../../src/e2e/archive.ts'

const at = new Date('2026-11-23T14:05:06.789Z')

function root(): string {
  return mkdtempSync(join(tmpdir(), 'acdev-evidence-'))
}

function scene(overrides: Partial<Evidence.Scene> = {}): Evidence.Scene {
  return {
    closed: false,
    screen: async () => ({ png: Buffer.from('png'), width: 1, height: 1, path: null }),
    webList: async () => ({ webs: [], locked: null }) as never,
    snapshot: async () => ({ text: '- desktop [w0]', windows: [{ ref: 'w0' }], trees: {} }) as never,
    query: async () => ({ window: 'w0', count: 0, nodes: [] }),
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
        'console.txt', 'error.txt', 'journal.txt', 'manifest.json', 'network.txt.error.txt', 'redacted.json', 'screen.png', 'snapshot.txt', 'webs.txt',
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
      check(readdirSync(gone.dir).sort()).toEqual(['error.txt', 'journal.txt', 'manifest.json', 'redacted.json'])
      const stuck = scene({ webList: () => new Promise(() => {}) })
      const late = await Evidence.keep(stuck, { root: dir, label: 'stuck', since: at, budgetMs: 50 })
      check(late.items.find((i) => i.file === 'webs.txt')?.ok).toBe(false)
      check(existsSync(join(late.dir, 'webs.txt.error.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the runs acdev test keeps', () => {
  test('each run gets a new folder, the newest 20 stay, older runs and the old layout go, and an empty run leaves nothing', () => {
    const dir = root()
    try {
      mkdirSync(join(dir, 'e2e-old', 'a-test'), { recursive: true })
      const made = Array.from({ length: KEEP_RUNS + 3 }, (_, i) => newRun(dir, new Date(at.getTime() + i * 1000)))
      const left = readdirSync(dir).sort()
      check(left.length).toBe(KEEP_RUNS)
      check(left[0]).toBe(made[3]!.slice(dir.length + 1))
      check(existsSync(join(dir, 'e2e-old'))).toBe(false)
      check(prune(dir, KEEP_RUNS)).toEqual([])
      check(dropEmpty(made.at(-1)!)).toBe(true)
      writeFileSync(join(made.at(-2)!, 'error.txt'), 'x')
      check(dropEmpty(made.at(-2)!)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('what evidence leaves out', () => {
  const window = (ref: string, kind: string, mode: string, rect: readonly number[]) =>
    ({ ref, id: Number(ref.slice(1)), kind, app: null, title: ref, mode, rect, z: 1, focus: false, hidden: false, pid: 1 }) as never
  const windows = [
    window('w0', 'desktop', 'desktop', [0, 0, 100, 50]),
    window('w1', 'web', 'free', [0, 0, 60, 40]),
    window('w2', 'web', 'confirm', [70, 0, 30, 20]),
  ]
  const trees = {
    w1: [
      { ref: 'w1.2', role: 'heading', name: 'Notes', rect: [0, 0, 60, 10] },
      { ref: 'w1.5', role: 'group', name: 'Card', rect: [10, 10, 20, 10], children: [{ ref: 'w1.6', role: 'textbox', name: 'Code', value: '4711' }] },
    ],
    w2: [{ ref: 'w2.3', role: 'textbox', name: 'Password', value: 'hunter2' }],
  }
  const text = [
    '- window "w1" [w1]', '  - heading "Notes" [w1.2]', '  - group "Card" [w1.5]', '    - textbox "Code": "4711" [w1.6]',
    '- window "w2" [confirm] [w2]', '  - textbox "Password": "hunter2" [w2.3]',
  ].join('\n')
  const screen = Png.encode({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(255) })
  const token = `ghp_${'a'.repeat(36)}`
  const userOnly = { ref: 'w1.5', role: 'group', name: 'Card', rect: [10, 10, 20, 10], tag: 'div', visible: true }
  const scene: Evidence.Scene = {
    closed: false,
    screen: async () => ({ png: screen, width: 200, height: 100, path: null }),
    webList: async () => ({ webs: [], locked: null }) as never,
    snapshot: async () => ({ text, windows, trees }) as never,
    query: async ({ window }) => ({ window: window!, count: window === 'w1' ? 1 : 0, nodes: window === 'w1' ? [userOnly] : [] }) as never,
    console: async () => {
      const entry = { seq: 1, time: 0, web: 'notes#1', app: 'notes', kind: 'console', level: 'log', text: `key secret://bank/pin and ${token}` }
      return { entries: [entry], next: 2 } as never
    },
    network: async () => ({ entries: [], next: 1 }) as never,
  }

  test('user-only areas, the confirm page and secrets are covered or replaced, and redacted.json counts each kind', async () => {
    const dir = root()
    try {
      const journal = async () => 'agent read AKIAABCDEFGHIJKLMNOP from the store'
      const kept = await Evidence.keep(scene, { root: dir, label: 'private', since: at, journal, now: () => at })
      const image = Png.decode(readFileSync(join(kept.dir, 'screen.png')))
      const pixel = (x: number, y: number) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]
      check(pixel(25, 25)).toEqual([...BLOCK_RGBA])
      check(pixel(150, 10)).toEqual([...BLOCK_RGBA])
      check(pixel(5, 5)).toEqual([255, 255, 255, 255])
      const snapshot = readFileSync(join(kept.dir, 'snapshot.txt'), 'utf8')
      check(snapshot).toContain('heading "Notes" [w1.2]')
      check(snapshot).toContain(`textbox "${PLACEHOLDER}": "${PLACEHOLDER}" [w1.6]`)
      check(snapshot).toContain(`textbox "${PLACEHOLDER}": "${PLACEHOLDER}" [w2.3]`)
      check(snapshot).not.toContain('4711')
      check(snapshot).not.toContain('hunter2')
      const logged = readFileSync(join(kept.dir, 'console.txt'), 'utf8') + readFileSync(join(kept.dir, 'journal.txt'), 'utf8')
      check(logged).not.toContain('secret://bank')
      check(logged).not.toContain(token)
      check(logged).not.toContain('AKIAABCDEFGHIJKLMNOP')
      check(JSON.parse(readFileSync(join(kept.dir, 'redacted.json'), 'utf8'))).toEqual({
        'screen: confirm': 1, 'screen: data-user-only': 1, 'snapshot: data-user-only': 2, 'snapshot: confirm': 1,
        'text: secret reference': 1, 'text: GitHub token': 1, 'text: AWS access key id': 1,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
