import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CapabilityStatus } from '@dopame/acde-api/manifest'
import type { Approval } from '../../src/broker/access/approval/permissions.ts'
import { Permits } from '../../src/broker/access/approval/permits.ts'
import type { WebInit } from '../../src/broker/types.ts'
import { RemoteBridge, WindowList } from '../../src/remote.ts'
import { Rpc } from '../../src/rpc.ts'

const failure = (run: () => unknown): { message: string; code?: string; status?: number; capability?: string } => {
  try {
    run()
  } catch (error) {
    const { message, code, status, capability } = error as Error & { code?: string; status?: number; capability?: string }
    return { message, code, status, capability }
  }
  throw new Error('did not throw')
}

test('a module that waits says whether it was asked for, is being asked, or was denied', () => {
  const permits = new Permits({ terminal: 'not-asked', launch: 'denied', slots: 'not-asked' }, 'Tool')
  assert.equal(permits.usable('terminal'), false)
  assert.equal(permits.reason('terminal'), 'acde:terminal: "terminal" is not asked for yet; ask for it with acde:capabilities request("terminal")')
  permits.set('terminal', 'asking')
  assert.equal(permits.reason('terminal'), `acde:terminal: "terminal" is waiting for the user's answer`)
  permits.set('terminal', 'denied')
  assert.equal(permits.reason('terminal'), 'acde:terminal: "terminal" is denied by the user')
  permits.set('terminal', 'granted')
  assert.equal(permits.usable('terminal'), true)
  assert.equal(
    permits.reason('launch'),
    'acde:launch: "launch" is denied by the user; "slots" is not asked for yet; ask for it with acde:capabilities request("slots")',
    'each gate of the module with its own state',
  )
  assert.equal(permits.usable('fs'), true, 'modules without a gate are not held back')
  assert.equal(permits.approval('office'), 'granted')
})

test('a call into a module that lost its approval fails with the state that holds', () => {
  const permits = new Permits({ terminal: 'granted' }, 'Tool')
  const terminal = permits.guard('terminal', { open: () => 'opened', columns: 80 })
  assert.equal(terminal.open(), 'opened')
  assert.equal(terminal.columns, 80)
  permits.set('terminal', 'denied')
  assert.deepEqual(failure(() => terminal.open()), { message: 'Tool: "terminal" is denied by the user', code: 'denied', status: 403, capability: 'terminal' })
})

const DEVICES = [
  { deviceId: 'mic1', kind: 'audioinput', label: 'Mic', groupId: 'g1', facingMode: null, modes: [], channelCount: 1 },
  { deviceId: 'cam1', kind: 'videoinput', label: 'Front', groupId: 'g1', facingMode: 'user', modes: [[640, 480, 30]], channelCount: 0 },
  { deviceId: 'cam2', kind: 'videoinput', label: 'Back', groupId: 'g2', facingMode: 'environment', modes: [[1920, 1080, 60]], channelCount: 0 },
] as const

const capturing = (approvals: Record<string, Approval>, options: { unsupported?: string[]; system?: 'granted' | 'denied' | 'prompt' } = {}) => {
  const permits = new Permits(approvals, 'Tool')
  const opened: string[] = []
  const asked: string[] = []
  const waiting = new Map<string, (status: CapabilityStatus | Error) => void>()
  const native = {
    devices: async () => DEVICES.map((device) => ({ ...device })),
    permission: () => options.system ?? ('granted' as const),
    open: async (kind: string) => (opened.push(kind), { source: 1 }) as never,
    close: () => {},
    onEnded: () => {},
  }
  const capture = permits.capture(native, {
    supported: (name) => !options.unsupported?.includes(name),
    request: (name) => {
      asked.push(name)
      return new Promise((resolve, reject) => waiting.set(name, (answer) => (answer instanceof Error ? reject(answer) : resolve(answer))))
    },
  })
  const changes: number[] = []
  capture.onPermission!(() => changes.push(changes.length))
  const answer = (name: string, state: CapabilityStatus['state'] | Error) =>
    waiting.get(name)!(state instanceof Error ? state : { name, kind: 'system', state, reason: state, optional: true })
  return { permits, capture, opened, asked, answer, changes }
}

test('camera and microphone: the permission a page sees follows the approval, then the system', () => {
  const { permits, capture, changes } = capturing({ camera: 'not-asked', microphone: 'granted' }, { system: 'prompt' })
  assert.equal(capture.permission('camera'), 'prompt', 'not asked yet: getUserMedia will ask')
  assert.equal(capture.permission('microphone'), 'prompt', 'approved: what the system says')
  permits.set('camera', 'asking')
  assert.equal(capture.permission('camera'), 'prompt')
  permits.set('camera', 'denied')
  assert.equal(capture.permission('camera'), 'denied')
  permits.set('camera', 'granted')
  assert.equal(capture.permission('camera'), 'prompt')
  assert.equal(changes.length, 3, 'each change of the approval is announced')
  permits.set('camera', 'granted')
  permits.set('terminal', 'denied')
  assert.equal(changes.length, 3, 'only a change of camera or microphone')
  const here = capturing({ camera: 'not-asked' }, { unsupported: ['camera'] })
  assert.equal(here.capture.permission('camera'), 'denied', 'nothing asks where the platform has no camera')
  assert.equal(capturing({}).capture.permission('camera'), 'granted', 'a web that needs no approval')
})

test('camera and microphone: request raises the prompt once and answers by the decision', async () => {
  const allowed = capturing({ camera: 'not-asked', microphone: 'not-asked' })
  const first = allowed.capture.request!('camera')
  assert.deepEqual(allowed.asked, ['camera'])
  allowed.answer('camera', 'available')
  assert.equal(await first, true)
  assert.equal(allowed.permits.approval('camera'), 'granted')
  assert.equal(allowed.capture.permission('camera'), 'granted')
  assert.equal(await allowed.capture.request!('camera'), true)
  assert.deepEqual(allowed.asked, ['camera'], 'an approved capability is not asked for again')
  await allowed.capture.open('videoinput', 'cam1', 0, 0, 0)
  assert.deepEqual(allowed.opened, ['videoinput'])

  const denied = capturing({ camera: 'not-asked' })
  const refused = denied.capture.request!('camera')
  denied.answer('camera', 'denied')
  assert.equal(await refused, false)
  assert.equal(denied.capture.permission('camera'), 'denied')
  assert.equal(await denied.capture.request!('camera'), false)
  assert.deepEqual(denied.asked, ['camera'], 'a denied capability is not asked for again')

  const failed = capturing({ camera: 'not-asked' })
  const broken = failed.capture.request!('camera')
  failed.answer('camera', new Error('the broker is gone'))
  assert.equal(await broken, false)
  assert.equal(failed.capture.permission('camera'), 'prompt', 'no decision was made')

  const missing = capturing({ camera: 'not-asked' }, { unsupported: ['camera'] })
  assert.equal(await missing.capture.request!('camera'), false)
  assert.deepEqual(missing.asked, [])
})

test('camera and microphone: a device opens only once approved, and the refusal is a NotAllowedError', async () => {
  const { permits, capture, opened } = capturing({ camera: 'not-asked', microphone: 'granted' })
  const refusal = (e: Error & { code?: string; capability?: string; status?: number }) =>
    e.message === 'NotAllowedError: Tool: "camera" is not asked for yet; ask for it with acde:capabilities request("camera")' &&
    e.code === 'not_asked' && e.capability === 'camera' && e.status === 403
  await assert.rejects(capture.open('videoinput', '', 0, 0, 0), refusal)
  await capture.open('audioinput', '', 0, 0, 0)
  assert.deepEqual(opened, ['audioinput'])
  permits.set('camera', 'denied')
  await assert.rejects(capture.open('videoinput', '', 0, 0, 0), (e: Error & { code?: string }) => e.message === 'NotAllowedError: Tool: "camera" is denied by the user' && e.code === 'denied')
})

test('camera and microphone: devices of a kind that is not approved are one entry without a name', async () => {
  const { permits, capture } = capturing({ camera: 'not-asked', microphone: 'granted' })
  const listed = async (full: boolean) => (await capture.devices(full)).map((d) => [d.kind, d.deviceId, d.label, d.groupId, d.facingMode])
  assert.deepEqual(await listed(false), [
    ['audioinput', 'mic1', 'Mic', 'g1', null],
    ['videoinput', '', '', '', null],
  ])
  assert.equal((await listed(true)).length, 3, 'getUserMedia chooses among all of them before it asks')
  permits.set('camera', 'granted')
  assert.deepEqual(await listed(false), [
    ['audioinput', 'mic1', 'Mic', 'g1', null],
    ['videoinput', 'cam1', 'Front', 'g1', 'user'],
    ['videoinput', 'cam2', 'Back', 'g2', 'environment'],
  ])
})

const bridge = (approvals: Record<string, Approval>) => {
  const rpc = new Rpc(() => {})
  const status = (name: string, state: CapabilityStatus['state']): CapabilityStatus => ({ name, kind: 'system', state, reason: state, optional: true })
  const init = {
    kind: 'window',
    name: 'tool#1',
    services: {},
    app: { id: 'tool', label: 'Tool', capabilities: { terminal: true } },
    tier: {
      level: 1,
      shell: [],
      refused: {},
      approvals,
      capabilities: { level: 1, platform: 'darwin', mode: 'standalone', window: { backdrop: 'full' }, statuses: [status('terminal', 'not-asked')] },
    },
  } as unknown as WebInit
  const remote = new RemoteBridge(rpc, init, null, new WindowList(rpc))
  remote.value['terminal'] = { open: () => 'opened' }
  const defined = new Map<string, object>()
  const refused = new Map<string, string>()
  remote.define({
    defineModule: (url, exports) => void (defined.set(url, exports), refused.delete(url)),
    refuseModule: (url, reason) => void refused.set(url, reason),
  })
  return { remote, defined, refused, status }
}

test('the import of a module follows the approval: not asked, asking, denied, then defined once it is allowed', () => {
  const { remote, defined, refused, status } = bridge({ terminal: 'not-asked' })
  const state = () => (remote.value['capabilities'] as { get(name: string): CapabilityStatus }).get('terminal').state
  assert.equal(refused.get('acde:terminal'), 'acde:terminal: "terminal" is not asked for yet; ask for it with acde:capabilities request("terminal")')
  assert.equal(state(), 'not-asked')
  remote.permit('terminal', 'asking', status('terminal', 'asking'))
  assert.equal(refused.get('acde:terminal'), `acde:terminal: "terminal" is waiting for the user's answer`)
  assert.equal(state(), 'asking')
  remote.permit('terminal', 'denied', status('terminal', 'denied'))
  assert.equal(refused.get('acde:terminal'), 'acde:terminal: "terminal" is denied by the user')
  assert.equal(state(), 'denied')
  assert.equal(defined.has('acde:terminal'), false)
  remote.permit('terminal', 'granted', status('terminal', 'available'))
  assert.equal(refused.has('acde:terminal'), false)
  assert.ok(defined.has('acde:terminal'))
  assert.equal(state(), 'available')
})
