import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppsChangedEvent } from '@dopame/acde-api'
import { Manifest, type AppManifest } from '@dopame/acde-api/manifest'
import type { AppRegistry } from '../../src/apps.ts'
import { CapabilityCheck } from '../../src/broker/access/capabilities.ts'
import { Approvals } from '../../src/broker/approvals.ts'
import { AppListing } from '../../src/broker/listing.ts'

const app = (fields: Record<string, unknown>): AppManifest => {
  const parsed = Manifest.app({ icon: 'app', entry: '/t/index.html', ...fields })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}

const session = () => {
  const installed = [
    app({ id: 'tool', label: 'Tool', capabilities: { camera: true } }),
    app({ id: 'notes', label: 'Notes', capabilities: { microphone: true }, optional: ['microphone'] }),
  ]
  const origin = { level: 1, system: false }
  const apps = { get: (id: string) => installed.find((a) => a.id === id) ?? null, origin: () => origin, list: () => installed } as unknown as AppRegistry
  const events: unknown[] = []
  const check: CapabilityCheck = new CapabilityCheck({
    platform: 'darwin',
    mode: () => 'desktop',
    running: () => true,
    present: () => true,
    approval: (a, o, capability) => approvals.permissions.approval(a, o, capability),
  })
  const listing = new AppListing({
    apps: () => installed.filter((a) => !check.missing(a, origin).length).map(({ id, label, icon, entry }) => ({ id, label, icon, script: entry })),
    tell: (event) => void events.push(event),
  })
  const approvals: Approvals = new Approvals({
    apps: () => apps,
    capabilities: () => check,
    records: () => [],
    toDesktop: (event) => void events.push(event),
    dialog: () => null,
    standalone: () => false,
    finder: () => null,
    store: () => null,
    log: () => {},
    listed: () => void listing.changed(),
  })
  const changes = () => events.filter((e): e is AppsChangedEvent => (e as { type?: string }).type === 'appschanged').map((e) => e.apps.map((a) => a.id))
  return { approvals, listing, installed, origin, changes }
}

test('an answer of no keeps the app on the list', async () => {
  const { approvals, listing, installed, origin, changes } = session()
  assert.deepEqual(listing.list().map((a) => a.id), ['tool', 'notes'])
  const asked = approvals.permissions.ask(installed[0]!, origin, 'camera', 'request')
  assert.deepEqual(changes(), [], 'an app whose prompt waits stays on the list')
  approvals.permissions.answer(approvals.permissions.pending()[0]!.id, false)
  assert.equal(await asked, false)
  assert.deepEqual(changes(), [])
  assert.deepEqual(listing.list().map((a) => a.id), ['tool', 'notes'])
})

test('granting or revoking the camera or the microphone changes no list', async () => {
  const { approvals, installed, origin, listing, changes } = session()
  listing.list()
  const camera = approvals.permissions.ask(installed[0]!, origin, 'camera', 'request')
  approvals.permissions.answer(approvals.permissions.pending()[0]!.id, true)
  assert.equal(await camera, true)
  const asked = approvals.permissions.ask(installed[1]!, origin, 'microphone', 'request')
  approvals.permissions.answer(approvals.permissions.pending()[0]!.id, true)
  await asked
  assert.deepEqual(changes(), [], 'granting changes no list')
  approvals.permissions.revoke('notes', 'microphone')
  assert.deepEqual(changes(), [])
  approvals.permissions.revoke('tool', 'camera')
  assert.deepEqual(changes(), [])
  assert.deepEqual(listing.list().map((a) => a.id), ['tool', 'notes'])
})

test('a forced change is told even when the rows are the same, and a list the desktop already has is not told again', () => {
  const rows = [{ id: 'a', label: 'A', icon: 'app', script: '/a.js' }]
  const told: AppsChangedEvent[] = []
  const listing = new AppListing({ apps: () => rows.map((row) => ({ ...row })), tell: (event) => void told.push(event) })
  listing.changed()
  assert.equal(told.length, 1, 'nothing was known before')
  listing.changed()
  assert.equal(told.length, 1)
  listing.changed(true)
  assert.equal(told.length, 2)
  rows.pop()
  listing.list()
  listing.changed()
  assert.equal(told.length, 2)
})
