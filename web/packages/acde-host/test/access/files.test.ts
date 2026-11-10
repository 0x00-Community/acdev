import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Manifest, type AppManifest, type RunningMode } from '@dopame/acde-api/manifest'
import type { AppOrigin } from '../../src/apps.ts'
import { CapabilityCheck } from '../../src/broker/access/capabilities.ts'
import { FileAccess } from '../../src/broker/access/files.ts'
import { Permissions, type Permit } from '../../src/broker/access/approval/permissions.ts'

const third: AppOrigin = { level: 1, system: false }
const system: AppOrigin = { level: 1, system: true }
const legacy: AppOrigin = { level: 0, system: false }
const app = (fields: Record<string, unknown>): AppManifest => {
  const parsed = Manifest.app({ id: 'tool', label: 'Tool', icon: 'app', entry: '/t/index.html', ...fields })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}
const permissions = () =>
  new Permissions({ store: null, label: () => 'Tool', supported: () => true, tell: () => {}, changed: () => {}, log: () => {} })

test('fs: true at level 1 gives only the private folder and picked folders', () => {
  assert.deepEqual(FileAccess.grant({ fs: true }, third), { places: [], paths: false })
  assert.deepEqual(FileAccess.grant({ fs: { roots: ['documents', 'pictures'] } }, third), { places: ['documents', 'pictures'], paths: false })
  assert.deepEqual(FileAccess.grant({ fs: { roots: ['documents'] } }, system), { places: ['documents'], paths: true })
  assert.equal(FileAccess.grant({}, third), null)
})

test('level 0 packages and system apps with fs: true keep every shared place for now', () => {
  assert.equal(FileAccess.grant({ fs: true }, legacy), true)
  assert.deepEqual(FileAccess.grant({ fs: { roots: ['/srv/notes'] } } as never, legacy), ['/srv/notes'])
  assert.equal(FileAccess.grant({ fs: true }, system), true)
  assert.equal(FileAccess.grant(null, null), true)
  assert.equal(FileAccess.deprecated({ fs: true }, system), true)
  assert.equal(FileAccess.deprecated({ fs: true }, third), false)
  assert.equal(FileAccess.deprecated({ fs: true }, legacy), false)
  assert.equal(FileAccess.deprecated({ fs: { roots: ['documents'] } }, system), false)
})

test('each shared place a third-party app names needs approval and is asked before launch', async () => {
  const p = permissions()
  const tool = app({ capabilities: { fs: { roots: ['documents', 'music'] } } })
  assert.deepEqual(p.gated(tool, third), ['fs.documents', 'fs.music'])
  assert.deepEqual(p.gated(tool, system), [])
  assert.deepEqual(p.gated(app({ capabilities: { fs: true } }), third), [])
  assert.ok(Permissions.approval('fs.documents'))
  assert.ok(!Permissions.approval('fs.agentos-work'))
  const admitted = p.admit(tool, third)
  await Promise.resolve()
  assert.deepEqual(p.pending().map((prompt) => prompt.capability), ['fs.documents'])
  p.answer(p.pending()[0]!.id, true)
  for (let i = 0; i < 10 && !p.pending().length; i++) await Promise.resolve()
  p.answer(p.pending()[0]!.id, false)
  await assert.rejects(admitted, (e: Error & { capability?: string }) => e.capability === 'fs.music')
})

test('places of an optional fs are asked on request', async () => {
  const p = permissions()
  const tool = app({ capabilities: { fs: { roots: ['videos'] } }, optional: ['fs'] })
  await p.admit(tool, third)
  assert.deepEqual(p.pending(), [])
  const asked = p.ask(tool, third, 'fs.videos', 'request')
  p.answer(p.pending()[0]!.id, true)
  assert.equal(await asked, true)
})

test('acde:capabilities reports each declared place', () => {
  const check = (denied: string[] = []) =>
    new CapabilityCheck({
      platform: 'win32',
      mode: () => 'desktop' as RunningMode,
      running: () => false,
      present: () => true,
      denied: (_, __, capability) => denied.includes(capability),
    })
  const tool = app({ capabilities: { fs: { roots: ['documents'] } } })
  const status = check().status('fs.documents', tool, third)
  assert.deepEqual(status, { name: 'fs.documents', kind: 'system', state: 'available', reason: 'available', optional: false })
  assert.equal(check().status('fs.music', tool, third).state, 'not-declared')
  assert.equal(check(['fs.documents']).status('fs.documents', tool, third).state, 'denied')
  assert.ok(check().statuses(tool, third).some((s) => s.name === 'fs.documents'))
  assert.deepEqual(check(['fs.documents']).missing(tool, third).map((s) => s.name), ['fs.documents'])
})

test('the page cannot use a place it was not allowed, and roots() leaves it out', async () => {
  const permits: Record<string, Permit> = { 'fs.documents': 'granted', 'fs.music': 'ask' }
  const calls: unknown[][] = []
  const native = {
    roots: async () => [{ id: 'private' }, { id: 'documents', place: 'documents' }, { id: 'music', place: 'music' }],
    list: async (...args: unknown[]) => void calls.push(args),
  }
  const fs = FileAccess.guard(native, (capability) => permits[capability] ?? null, 'Tool')
  assert.deepEqual((await fs.roots()).map((root) => root.id), ['private', 'documents'])
  await fs.list('documents', '')
  await fs.list('private', '')
  await assert.rejects(fs.list('music', ''), (e: Error & { status?: number; code?: string; capability?: string }) =>
    e.status === 403 && e.code === 'denied' && e.capability === 'fs.music')
  permits['fs.music'] = 'granted'
  await fs.list('music', '')
  assert.deepEqual(calls.map((args) => args[0]), ['documents', 'private', 'music'])
})
