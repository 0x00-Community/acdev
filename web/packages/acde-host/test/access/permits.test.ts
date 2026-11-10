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

test('camera and microphone that were not asked for say so when opened', async () => {
  const permits = new Permits({ camera: 'not-asked', microphone: 'granted' }, 'Tool')
  const opened: string[] = []
  const capture = permits.capture({
    devices: async () => [],
    permission: () => 'granted',
    open: async (kind) => (opened.push(kind), { source: 1 }) as never,
    close: () => {},
    onEnded: () => {},
  })
  await assert.rejects(capture.open('videoinput', '', 0, 0, 0), (e: Error & { code?: string; capability?: string }) => e.code === 'not_asked' && e.capability === 'camera')
  await capture.open('audioinput', '', 0, 0, 0)
  assert.deepEqual(opened, ['audioinput'])
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
