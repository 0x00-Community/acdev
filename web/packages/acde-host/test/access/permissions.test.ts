import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PermissionAnsweredEvent, PermissionPromptEvent } from '@dopame/acde-api'
import type { AppManifest } from '../../src/apps.ts'
import { Permissions, type Permit } from '../../src/broker/access/approval/permissions.ts'
import { DevRequests } from '../../src/broker/dev.ts'

const files = new Map<string, Record<string, string>>()
const stored = (file: string) => {
  let pending: Record<string, string> | null = null
  return {
    read: () => files.get(file) ?? null,
    changed: (entries: Record<string, string>) => void (pending = entries),
    flush: () => void (pending && files.set(file, JSON.parse(JSON.stringify(pending)))),
  }
}

const third = { level: 1, system: false }
const system = { level: 1, system: true }
const legacy = { level: 0, system: false }
const app = (capabilities: Record<string, unknown>, optional: string[] = []) =>
  ({ id: 'tool', label: 'Tool', icon: 'app', entry: '/t/index.html', capabilities, optional, services: [], requests: [] }) as unknown as AppManifest

const next = async (permissions: Permissions) => {
  for (let i = 0; i < 20 && !permissions.pending().length; i++) await Promise.resolve()
  return permissions.pending()[0]!
}

const open = (file = Math.random().toString(36).slice(2)) => {
  const told: (PermissionPromptEvent | PermissionAnsweredEvent)[] = []
  const changes: [string, string, Permit][] = []
  const permissions = new Permissions({
    store: stored(file),
    label: (id) => (id === 'tool' ? 'Tool' : null),
    supported: (name) => name !== 'slots',
    tell: (event) => void told.push(event),
    changed: (id, capability, permit) => void changes.push([id, capability, permit]),
    log: () => {},
  })
  return { permissions, told, changes, file }
}

test('only capabilities that reach outside the app wait for approval', () => {
  const { permissions } = open()
  const tool = app({ office: true, open: true, openFiles: true, fs: true, launch: true, network: true, camera: true })
  assert.deepEqual(permissions.gated(tool, third), ['launch', 'network', 'camera'])
  assert.equal(permissions.permit(tool, third, 'office'), 'granted')
  assert.equal(permissions.permit(tool, third, 'launch'), 'ask')
})

test('system apps and level 0 packages are granted without a prompt', async () => {
  const { permissions, told } = open()
  const tool = app({ launch: true, terminal: true })
  assert.deepEqual(permissions.gated(tool, system), [])
  assert.deepEqual(permissions.gated(tool, legacy), [])
  await permissions.admit(tool, system)
  await permissions.admit(tool, legacy)
  assert.equal(permissions.permit(tool, system, 'launch'), 'granted')
  assert.deepEqual(told, [])
})

test('a required capability is asked before launch; an answer of no refuses with a typed error', async () => {
  const { permissions, told } = open()
  const tool = app({ launch: true, slots: true, terminal: true }, ['terminal'])
  const admitted = permissions.admit(tool, third)
  await Promise.resolve()
  const prompts = permissions.pending()
  const launch = { id: 1, app: 'tool', label: 'Tool', capability: 'launch', reason: 'launch' }
  assert.deepEqual(prompts, [launch], 'unsupported slots and optional terminal are not asked')
  assert.deepEqual(told, [{ type: 'permissionprompt', ...prompts[0]! }])
  permissions.answer(1, false)
  await assert.rejects(admitted, (e: Error & { status?: number; code?: string; capability?: string }) =>
    e.status === 403 && e.code === 'denied' && e.capability === 'launch' && /denied by the user/.test(e.message))
  assert.deepEqual(told[1], { type: 'permissionanswered', id: 1, app: 'tool', capability: 'launch', allowed: false })
  assert.equal(permissions.permit(tool, third, 'launch'), 'denied')
})

test('an optional capability is asked on request, and the same prompt is shared while it waits', async () => {
  const { permissions } = open()
  const tool = app({ terminal: true }, ['terminal'])
  await permissions.admit(tool, third)
  assert.deepEqual(permissions.pending(), [])
  const first = permissions.ask(tool, third, 'terminal', 'request')
  const second = permissions.ask(tool, third, 'terminal', 'request')
  assert.equal(permissions.pending().length, 1)
  permissions.answer(permissions.pending()[0]!.id, true)
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(permissions.permit(tool, third, 'terminal'), 'granted')
})

test('decisions persist across restarts', async () => {
  const { permissions, file } = open()
  const tool = app({ launch: true, network: true })
  const asked = permissions.admit(tool, third)
  permissions.answer((await next(permissions)).id, true)
  permissions.answer((await next(permissions)).id, false)
  await assert.rejects(asked)
  const again = open(file).permissions
  assert.equal(again.permit(tool, third, 'launch'), 'granted')
  assert.equal(again.permit(tool, third, 'network'), 'denied')
  assert.deepEqual(again.list('tool'), [
    { app: 'tool', label: 'Tool', capability: 'launch', decision: 'granted' },
    { app: 'tool', label: 'Tool', capability: 'network', decision: 'denied' },
  ])
})

test('revoking takes a decision back at once, one run never asks twice, and the next run asks again', async () => {
  const { permissions, changes, file, told } = open()
  const tool = app({ launch: true })
  const asked = permissions.admit(tool, third)
  await Promise.resolve()
  permissions.answer(permissions.pending()[0]!.id, true)
  await asked
  assert.equal(permissions.revoke('tool', 'launch'), true)
  assert.deepEqual(changes.at(-1), ['tool', 'launch', 'denied'])
  assert.equal(permissions.permit(tool, third, 'launch'), 'denied')
  const before = told.length
  assert.equal(await permissions.ask(tool, third, 'launch', 'request'), false)
  assert.equal(told.length, before, 'no second prompt in this run')
  assert.deepEqual(permissions.list('tool'), [])
  assert.equal(open(file).permissions.permit(tool, third, 'launch'), 'ask')
  assert.throws(() => permissions.revoke('tool', 'office'), (e: Error & { status?: number }) => e.status === 400)
})

test('the acde driver lists and answers prompts through the dev requests', async () => {
  const { permissions } = open()
  const replies: [number, boolean, string][] = []
  const devRespond = (id: number, ok: boolean, payload: string) => void replies.push([id, ok, payload])
  const dev = new DevRequests({ shell: { devRespond }, permissions } as never)
  const asked = permissions.ask(app({ launch: true }), third, 'launch', 'launch')
  await dev.request(JSON.stringify({ id: 1, op: 'permissions' }))
  assert.deepEqual(JSON.parse(replies[0]![2]), { pending: [{ id: 1, app: 'tool', label: 'Tool', capability: 'launch', reason: 'launch' }], decisions: [] })
  await dev.request(JSON.stringify({ id: 2, op: 'answer', prompt: 1, allow: true }))
  assert.equal(await asked, true)
  await dev.request(JSON.stringify({ id: 3, op: 'answer', prompt: 1, allow: true }))
  assert.deepEqual(replies.slice(1).map(([id, ok]) => [id, ok]), [[2, true], [3, false]])
})

test('folders an app holds are listed by token and revoked like approvals', () => {
  const held = new Map([['tool', [{ id: 'folder-0123456789abcdef', label: 'Notes', exists: true }]], ['other', []]])
  const changes: [string, string, Permit][] = []
  const permissions = new Permissions({
    store: null,
    label: (id) => (id === 'tool' ? 'Tool' : null),
    supported: () => true,
    tell: () => {},
    changed: (id, capability, permit) => void changes.push([id, capability, permit]),
    log: () => {},
    folders: (appId) => [...held].filter(([app]) => appId === undefined || app === appId).flatMap(([app, list]) => list.map((f) => ({ app, ...f }))),
    revokeFolder: (appId, id) => {
      const list = held.get(appId) ?? []
      const kept = list.filter((f) => f.id !== id)
      held.set(appId, kept)
      return kept.length !== list.length
    },
  })
  const row = { app: 'tool', label: 'Tool', capability: 'fs.folder-0123456789abcdef', decision: 'granted', folder: { label: 'Notes', exists: true } }
  assert.deepEqual(permissions.list(), [row])
  assert.deepEqual(permissions.list('other'), [])
  assert.equal(permissions.revoke('tool', 'fs.folder-0123456789abcdef'), true)
  assert.deepEqual(changes, [['tool', 'fs.folder-0123456789abcdef', 'denied']])
  assert.deepEqual(permissions.list('tool'), [])
  assert.equal(permissions.revoke('tool', 'fs.folder-0123456789abcdef'), false)
  assert.throws(() => permissions.revoke('tool', 'fs.folder-nothex'), (e: Error & { status?: number }) => e.status === 400)
})
