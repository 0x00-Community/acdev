import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, tmp } from '../helpers.ts'
import { backend, changed, push, record, reloads, stamps, type Guest } from '../../src/push/index.ts'
import type { PushFile } from '../../src/vm/devd.ts'
import { PROVISION_SCRIPT } from '../../src/vm/provision.ts'

afterAll(cleanup)

function built(dir: string) {
  return { dir, id: 'notes', apps: ['notes'], desktops: [], level: 1 }
}

function files(dir: string): void {
  mkdirSync(join(dir, 'web'), { recursive: true })
  mkdirSync(join(dir, 'backend'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(join(dir, 'web', 'index.js'), 'one')
  writeFileSync(join(dir, 'backend', 'server.js'), 'serve')
  for (const path of ['package.json', 'web/index.js', 'backend/server.js']) utimesSync(join(dir, path), 1000, 1000)
}

class FakeGuest implements Guest {
  readonly ran: string[][] = []
  readonly pushed: PushFile[] = []
  readonly record: string | null
  constructor(record: string | null) {
    this.record = record
  }
  async run(argv: readonly string[], out?: (text: string) => void): Promise<number> {
    this.ran.push([...argv])
    if (argv[0] === '/bin/cat') {
      if (this.record === null) return 1
      out?.(this.record)
    }
    return 0
  }
  async push(files: readonly PushFile[]): Promise<number> {
    this.pushed.push(...files)
    return files.length
  }
}

describe('acdev push', () => {
  test('stamps each file by size and time, and sends only what changed', () => {
    const dir = tmp()
    files(dir)
    const now = stamps(dir)
    expect(now['web/index.js']).toEqual([3, 1_000_000])
    expect(changed(now, now)).toEqual({ send: [], gone: [] })
    const before = { ...now, 'web/old.js': [1, 1] as const, 'web/index.js': [3, 999] as const }
    expect(changed(now, before)).toEqual({ send: ['web/index.js'], gone: ['web/old.js'] })
  })

  test('knows a backend file, the apps and the desktop to reload, and the commit it came from', () => {
    expect(backend(['web/a.js', 'backend/server.js', 'services/agent.js', 'apps/notes/backend/x.js', 'apps/notes/web/y.js']))
      .toEqual(['backend/server.js', 'services/agent.js', 'apps/notes/backend/x.js'])
    expect(reloads({ ...built('/x'), desktops: ['dopame'], apps: ['notes', 'files'] })).toEqual(['--reload', 'notes', '--reload', 'files', '--desktop'])
    const outside = record(tmp(), {}, new Date(0))
    expect(outside).toEqual({ commit: null, dirty: false, at: '1970-01-01T00:00:00.000Z', files: {} })
  })

  test('sends the changed files and push.json into the overlay, removes the gone ones, then has the agent mount and reload', async () => {
    const dir = tmp()
    files(dir)
    const said: string[] = []
    const fresh = new FakeGuest(null)
    expect(await push(fresh, built(dir), dir, (line) => said.push(line))).toBe(0)
    expect(fresh.pushed.map((f) => f.path).sort()).toEqual([
      '/var/lib/acdev/overlay/notes/backend/server.js', '/var/lib/acdev/overlay/notes/package.json',
      '/var/lib/acdev/overlay/notes/push.json', '/var/lib/acdev/overlay/notes/web/index.js',
    ])
    expect(fresh.ran.at(-1)).toEqual(['/usr/bin/acdev-agent', 'overlay', 'mount', 'notes', '--reload', 'notes'])
    expect(said.some((line) => line.includes('the backend changed (backend/server.js)'))).toBe(true)
    const kept = JSON.stringify({ files: { ...stamps(dir), 'web/old.js': [1, 1] } })
    const again = new FakeGuest(kept)
    await push(again, built(dir), dir, () => {})
    expect(again.pushed.map((f) => f.path)).toEqual(['/var/lib/acdev/overlay/notes/push.json'])
    expect(again.ran).toContainEqual(['/bin/rm', '-f', '--', '/var/lib/acdev/overlay/notes/web/old.js'])
  })

  test('provision takes the pushed packages away before it installs', () => {
    expect(PROVISION_SCRIPT).toContain('/usr/bin/acdev-agent overlay reset')
    expect(PROVISION_SCRIPT.indexOf('overlay reset')).toBeLessThan(PROVISION_SCRIPT.indexOf('the packages from --pkgs'))
  })
})
