import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Manifest, type AppManifest, type RunningMode } from '@dopame/acde-api/manifest'
import type { AppOrigin } from '../../src/apps.ts'
import { CapabilityCheck } from '../../src/broker/access/capabilities.ts'
import { FileAccess } from '../../src/broker/access/files.ts'

const third: AppOrigin = { level: 1, system: false }
const system: AppOrigin = { level: 1, system: true }
const app = (fields: Record<string, unknown>): AppManifest => {
  const parsed = Manifest.app({ id: 'tool', label: 'Tool', icon: 'app', entry: '/t/index.html', ...fields })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}
test('fs: true at level 1 gives only the private folder and picked folders', () => {
  assert.deepEqual(FileAccess.grant({ fs: true }, third), { places: [], paths: false })
  assert.deepEqual(FileAccess.grant({ fs: { roots: ['documents', 'pictures'] } }, third), { places: ['documents', 'pictures'], paths: false })
  assert.deepEqual(FileAccess.grant({ fs: { roots: ['documents'] } }, system), { places: ['documents'], paths: true })
  assert.equal(FileAccess.grant({}, third), null)
})

test('fs: true means the private folder and picked folders for system apps too; only the desktop keeps every place', () => {
  assert.deepEqual(FileAccess.grant({ fs: true }, system), { places: [], paths: false })
  assert.equal(FileAccess.grant(null, null), true)
})

test('acde:capabilities reports each declared place', () => {
  const check = () =>
    new CapabilityCheck({ platform: 'win32', mode: () => 'desktop' as RunningMode, running: () => false, present: () => true })
  const tool = app({ capabilities: { fs: { roots: ['documents'] } } })
  const status = check().status('fs.documents', tool, third)
  assert.deepEqual(status, { name: 'fs.documents', kind: 'system', state: 'available', reason: 'available', optional: false })
  assert.equal(check().status('fs.music', tool, third).state, 'not-declared')
  assert.ok(check().statuses(tool, third).some((s) => s.name === 'fs.documents'))
  assert.deepEqual(check().missing(tool, third), [])
})

test('open file requests give third-party apps only a handle; system apps with places keep their paths', () => {
  assert.equal(FileAccess.view({ fs: true }, third), 'handle')
  assert.equal(FileAccess.view({ fs: { roots: ['documents'] } }, third), 'handle')
  assert.equal(FileAccess.view({}, third), 'handle')
  assert.equal(FileAccess.view({ fs: { roots: ['documents'] } }, system), 'url')
  assert.equal(FileAccess.view({}, system), 'url')
  assert.equal(FileAccess.view({ fs: true }, system), 'handle')
})

test('an open file request from a level 1 app is admitted through its declared places', async () => {
  const { Web } = await import('../../src/broker/web.ts')
  const writer = app({ capabilities: { fs: { roots: ['documents', 'pictures'] } } })
  const caller = Web.caller(writer, { level: 1, system: false, shell: [], refused: {} })
  assert.deepEqual(caller, { roots: [], owner: 'tool', places: ['documents', 'pictures'], paths: false })
  const own = Web.caller(app({ capabilities: { fs: true } }), { level: 1, system: true, shell: [], refused: {} })
  assert.deepEqual(own, { roots: [], owner: 'tool', places: [], paths: false })
})
