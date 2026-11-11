import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PermissionAnsweredEvent, PermissionPromptEvent } from '@dopame/acde-api'
import type { AppManifest } from '../../src/apps.ts'
import { Permissions, type Approval } from '../../src/broker/access/approval/permissions.ts'
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
const app = (capabilities: Record<string, unknown>, optional: string[] = []) =>
  ({ id: 'tool', label: 'Tool', icon: 'app', entry: '/t/index.html', capabilities, optional, services: [], requests: [] }) as unknown as AppManifest

const next = async (permissions: Permissions) => {
  for (let i = 0; i < 20 && !permissions.pending().length; i++) await Promise.resolve()
  return permissions.pending()[0]!
}

const open = (file = Math.random().toString(36).slice(2)) => {
  const told: (PermissionPromptEvent | PermissionAnsweredEvent)[] = []
  const changes: [string, string, Approval][] = []
  const permissions = new Permissions({
    store: stored(file),
    label: (id) => (id === 'tool' ? 'Tool' : null),
    supported: (name) => name !== 'slots',
    tell: (event) => void told.push(event),
    changed: (id, capability, approval) => void changes.push([id, capability, approval]),
    log: () => {},
  })
  return { permissions, told, changes, file }
}

test('only the camera and the microphone wait for approval', () => {
  const { permissions } = open()
  const tool = app({ office: true, openFiles: true, fs: { roots: ['documents'] }, launch: true, terminal: true, network: true, camera: true, microphone: true })
  assert.deepEqual(permissions.gated(tool, third), ['camera', 'microphone'])
  for (const name of ['office', 'launch', 'terminal', 'network', 'fs.documents']) assert.equal(permissions.permit(tool, third, name), 'granted', name)
  assert.equal(permissions.permit(tool, third, 'camera'), 'ask')
})

test('system apps are granted without a prompt', async () => {
  const { permissions, told } = open()
  const tool = app({ camera: true, microphone: true })
  assert.deepEqual(permissions.gated(tool, system), [])
  assert.equal(await permissions.ask(tool, system, 'camera', 'request'), true)
  assert.equal(permissions.permit(tool, system, 'camera'), 'granted')
  assert.deepEqual(told, [])
})

test('a declared camera is asked when the app first uses it, not before; no is remembered', async () => {
  const { permissions, told } = open()
  const tool = app({ camera: true, slots: true, microphone: true })
  assert.deepEqual(permissions.approvals(tool, third), { camera: 'not-asked', microphone: 'not-asked' })
  assert.deepEqual(told, [], 'nothing is asked before a use')
  const asked = permissions.ask(tool, third, 'camera', 'request')
  const prompts = permissions.pending()
  assert.deepEqual(prompts, [{ id: 1, app: 'tool', label: 'Tool', capability: 'camera', reason: 'request' }], 'only the camera in use is asked')
  assert.deepEqual(told, [{ type: 'permissionprompt', ...prompts[0]! }])
  permissions.answer(1, false)
  assert.equal(await asked, false)
  assert.deepEqual(told[1], { type: 'permissionanswered', id: 1, app: 'tool', capability: 'camera', allowed: false })
  assert.equal(permissions.permit(tool, third, 'camera'), 'denied')
  assert.equal(permissions.approval(tool, third, 'microphone'), 'not-asked')
})

test('an optional capability is asked on request, and the same prompt is shared while it waits', async () => {
  const { permissions } = open()
  const tool = app({ microphone: true }, ['microphone'])
  const first = permissions.ask(tool, third, 'microphone', 'request')
  const second = permissions.ask(tool, third, 'microphone', 'request')
  assert.equal(permissions.pending().length, 1)
  permissions.answer(permissions.pending()[0]!.id, true)
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(permissions.permit(tool, third, 'microphone'), 'granted')
})

test('an app sees whether a capability was not asked for, is being asked, or was answered', async () => {
  const { permissions, changes } = open()
  const tool = app({ microphone: true, camera: true, office: true, fs: { roots: ['downloads'] } }, ['microphone', 'camera', 'fs'])
  assert.deepEqual(permissions.approvals(tool, third), { microphone: 'not-asked', camera: 'not-asked' })
  assert.equal(permissions.approval(tool, third, 'fs.downloads'), 'granted', 'shared places are granted on declaration')
  assert.equal(permissions.approval(tool, third, 'office'), 'granted', 'not given by approval')
  assert.equal(permissions.approval(tool, system, 'microphone'), 'granted', 'system apps are not asked')
  const asked = permissions.ask(tool, third, 'microphone', 'request')
  assert.equal(permissions.approval(tool, third, 'microphone'), 'asking')
  assert.deepEqual(changes, [['tool', 'microphone', 'asking']], 'the app is told that the prompt is up')
  assert.equal(permissions.approval(tool, third, 'camera'), 'not-asked')
  permissions.answer(permissions.pending()[0]!.id, false)
  assert.equal(await asked, false)
  assert.equal(permissions.approval(tool, third, 'microphone'), 'denied')
  assert.deepEqual(changes.at(-1), ['tool', 'microphone', 'denied'])
  const camera = permissions.ask(tool, third, 'camera', 'request')
  permissions.answer(permissions.pending()[0]!.id, true)
  assert.equal(await camera, true)
  assert.deepEqual(permissions.approvals(tool, third), { microphone: 'denied', camera: 'granted' })
  assert.equal(permissions.revoke('tool', 'camera'), true)
  assert.equal(permissions.approval(tool, third, 'camera'), 'denied', 'a revoked capability is not asked again in this run')
})

test('the error says which of the three states holds', () => {
  const error = (approval?: 'denied' | 'not-asked' | 'asking') => {
    const { message, status, code, capability } = Permissions.error('Tool', 'camera', approval)
    return { message, status, code, capability }
  }
  assert.deepEqual(error(), { message: 'Tool: "camera" is denied by the user', status: 403, code: 'denied', capability: 'camera' })
  assert.deepEqual(error('not-asked'), {
    message: 'Tool: "camera" is not asked for yet; ask for it with acde:capabilities request("camera")',
    status: 403,
    code: 'not_asked',
    capability: 'camera',
  })
  assert.deepEqual(error('asking'), { message: `Tool: "camera" is waiting for the user's answer`, status: 403, code: 'asking', capability: 'camera' })
})

test('decisions persist across restarts', async () => {
  const { permissions, file } = open()
  const tool = app({ camera: true, microphone: true })
  const camera = permissions.ask(tool, third, 'camera', 'request')
  const microphone = permissions.ask(tool, third, 'microphone', 'request')
  const [first, second] = permissions.pending()
  permissions.answer(first!.id, true)
  permissions.answer(second!.id, false)
  assert.deepEqual(await Promise.all([camera, microphone]), [true, false])
  const again = open(file).permissions
  assert.equal(again.permit(tool, third, 'camera'), 'granted')
  assert.equal(again.permit(tool, third, 'microphone'), 'denied')
  assert.deepEqual(again.list('tool'), [
    { app: 'tool', label: 'Tool', capability: 'camera', decision: 'granted' },
    { app: 'tool', label: 'Tool', capability: 'microphone', decision: 'denied' },
  ])
})

test('revoking takes a decision back at once, one run never asks twice, and the next run asks again', async () => {
  const { permissions, changes, file, told } = open()
  const tool = app({ camera: true })
  const asked = permissions.ask(tool, third, 'camera', 'request')
  permissions.answer(permissions.pending()[0]!.id, true)
  assert.equal(await asked, true)
  assert.equal(permissions.revoke('tool', 'camera'), true)
  assert.deepEqual(changes.at(-1), ['tool', 'camera', 'denied'])
  assert.equal(permissions.permit(tool, third, 'camera'), 'denied')
  const before = told.length
  assert.equal(await permissions.ask(tool, third, 'camera', 'request'), false)
  assert.equal(told.length, before, 'no second prompt in this run')
  assert.deepEqual(permissions.list('tool'), [])
  assert.equal(open(file).permissions.permit(tool, third, 'camera'), 'ask')
  assert.throws(() => permissions.revoke('tool', 'office'), (e: Error & { status?: number }) => e.status === 400)
})

test('the acde driver lists and answers prompts through the dev requests', async () => {
  const { permissions } = open()
  const replies: [number, boolean, string][] = []
  const devRespond = (id: number, ok: boolean, payload: string) => void replies.push([id, ok, payload])
  const dev = new DevRequests({ shell: { devRespond }, permissions } as never)
  const asked = permissions.ask(app({ camera: true }), third, 'camera', 'request')
  await dev.request(JSON.stringify({ id: 1, op: 'permissions' }))
  assert.deepEqual(JSON.parse(replies[0]![2]), { pending: [{ id: 1, app: 'tool', label: 'Tool', capability: 'camera', reason: 'request' }], decisions: [] })
  await dev.request(JSON.stringify({ id: 2, op: 'answer', prompt: 1, allow: true }))
  assert.equal(await asked, true)
  await dev.request(JSON.stringify({ id: 3, op: 'answer', prompt: 1, allow: true }))
  assert.deepEqual(replies.slice(1).map(([id, ok]) => [id, ok]), [[2, true], [3, false]])
})

test('folders an app holds are listed by token and revoked like approvals', () => {
  const held = new Map([['tool', [{ id: 'folder-0123456789abcdef', label: 'Notes', exists: true }]], ['other', []]])
  const changes: [string, string, Approval][] = []
  const permissions = new Permissions({
    store: null,
    label: (id) => (id === 'tool' ? 'Tool' : null),
    supported: () => true,
    tell: () => {},
    changed: (id, capability, approval) => void changes.push([id, capability, approval]),
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

test('acdert app asks again about a denial of an earlier run; a desktop keeps it', async () => {
  const file = 'again'
  files.set(file, { 'tool:camera': 'denied', 'tool:microphone': 'granted' })
  const tool = app({ camera: true, microphone: true })
  const make = (asksAgain: boolean) =>
    new Permissions({ store: stored(file), label: () => 'Tool', supported: () => true, tell: () => {}, changed: () => {}, log: () => {}, asksAgain: () => asksAgain })

  const desktop = make(false)
  assert.equal(desktop.approval(tool, third, 'camera'), 'denied')
  assert.equal(await desktop.ask(tool, third, 'camera', 'request'), false)
  assert.deepEqual(desktop.pending(), [])

  const standalone = make(true)
  assert.equal(standalone.approval(tool, third, 'camera'), 'not-asked', 'the earlier denial is asked about again')
  assert.equal(await standalone.ask(tool, third, 'microphone', 'request'), true, 'the granted microphone is not asked')
  const asked = standalone.ask(tool, third, 'camera', 'request')
  const prompt = await next(standalone)
  assert.deepEqual([prompt.capability, prompt.reason], ['camera', 'request'])
  assert.deepEqual(files.get(file), { 'tool:microphone': 'granted' }, 'the old denial is dropped once it is asked again')
  standalone.answer(prompt.id, false)
  assert.equal(await asked, false)
  assert.deepEqual(files.get(file), { 'tool:microphone': 'granted', 'tool:camera': 'denied' })
  assert.equal(await standalone.ask(tool, third, 'camera', 'request'), false, 'a no of this run is not asked twice')
  assert.deepEqual(standalone.pending(), [])
})
