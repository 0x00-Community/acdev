import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { API_LEVEL, Manifest, type AppManifest, type RunningMode } from '@dopame/acde-api/manifest'
import { CapabilityCheck, type CapabilityHost } from '../src/broker/access/capabilities.ts'
import type { AppOrigin } from '../src/apps.ts'
import type { Approval } from '../src/broker/access/approval/permissions.ts'

const third: AppOrigin = { level: 1, system: false }
const system: AppOrigin = { level: 1, system: true }
const app = (fields: Record<string, unknown>): AppManifest => {
  const parsed = Manifest.app({ id: 'demo', label: 'Demo', icon: 'app', entry: '/demo/index.html', ...fields })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}
const check = (platform: string, mode: RunningMode, running: string[] = [], absent: string[] = [], approvals: Record<string, Approval> = {}) =>
  new CapabilityCheck({
    platform,
    mode: () => mode,
    running: (service) => running.includes(service),
    present: (capability) => !absent.includes(capability),
    approval: (_, __, capability) => approvals[capability] ?? 'granted',
  } satisfies CapabilityHost)
const state = (c: CapabilityCheck, name: string, a: AppManifest | null, origin: AppOrigin = third) => c.status(name, a, origin).state

describe('CapabilityCheck', () => {
  test('a capability the table leaves out is unsupported on this platform', () => {
    const office = app({ capabilities: { office: true } })
    assert.equal(state(check('win32', 'desktop'), 'office', office), 'unsupported')
    assert.equal(state(check('linux', 'desktop'), 'office', office), 'available')
    const slots = app({ capabilities: { slots: true } })
    assert.equal(state(check('linux', 'standalone'), 'slots', slots), 'unsupported')
    assert.equal(state(check('linux', 'session'), 'slots', slots), 'available')
    assert.equal(state(check('win32', 'session'), 'fs', app({ capabilities: { fs: true } })), 'unsupported')
  })

  test('notifications need no declaration and only a Windows standalone window lacks them', () => {
    const plain = app({})
    for (const [platform, mode] of [['linux', 'session'], ['linux', 'standalone'], ['darwin', 'standalone'], ['win32', 'desktop']] as const) {
      assert.equal(state(check(platform, mode), 'notifications', plain), 'available', `${platform} ${mode}`)
    }
    const windows = check('win32', 'standalone')
    assert.deepEqual(windows.status('notifications', plain, third), {
      name: 'notifications',
      kind: 'system',
      state: 'unsupported',
      reason: 'unsupported on this platform',
      optional: false,
    })
    assert.ok(windows.statuses(plain, third).some((s) => s.name === 'notifications' && s.state === 'unsupported'))
    assert.equal(windows.refusal(plain, third), null)
  })

  test('a capability the runtime could not open is unsupported too', () => {
    assert.equal(state(check('linux', 'session', [], ['office']), 'office', app({ capabilities: { office: true } })), 'unsupported')
  })

  test('undeclared, shell only and service states', () => {
    const c = check('win32', 'desktop', ['desk'])
    const a = app({ capabilities: { fs: true }, services: ['desk', 'agent'] })
    assert.equal(state(c, 'network', a), 'not-declared')
    assert.equal(state(c, 'windows', a), 'shell-only')
    assert.equal(state(c, 'windows', app({ capabilities: { windows: true } }), system), 'available')
    assert.equal(state(c, 'desk', a), 'available')
    assert.equal(state(c, 'agent', a), 'service-not-running')
    assert.equal(state(c, 'desk', app({ capabilities: { desk: true } })), 'available')
    assert.equal(c.status('agent', a, third).reason, 'service not running')
    assert.equal(c.status('agent', a, third).kind, 'service')
  })

  test('required capabilities refuse the app and name what is missing', () => {
    const c = check('win32', 'desktop')
    const refusal = c.refusal(app({ label: 'Docs', capabilities: { office: true, fs: true } }), third) as Error & { status: number; code: string }
    assert.equal(refusal.message, 'Docs needs "office" (not available on Windows host windows); list it in "optional" to run without it')
    assert.equal(refusal.status, 404)
    assert.equal(refusal.code, 'unsupported_app')
    const stopped = c.refusal(app({ label: 'Board', services: ['desk'] }), third) as Error & { status: number; code: string }
    assert.equal(stopped.message, 'Board needs "desk" (service not running)')
    assert.equal(stopped.status, 503)
    assert.equal(c.refusal(app({ capabilities: { office: true }, optional: ['office'] }), third), null)
    const network = c.refusal(app({ capabilities: { network: true, fs: true } }), third)?.message
    assert.equal(network, 'Demo needs "network" (not available on Windows host windows); list it in "optional" to run without it')
    assert.match(String(check('linux', 'desktop').refusal(app({ capabilities: { slots: true } }), third)), /not available on Linux host windows/)
  })

  test('declared but unavailable module capabilities get a refusal reason at import', () => {
    const refused = check('win32', 'desktop').refusedModules(app({ capabilities: { office: true, fs: true }, optional: ['office'] }), third)
    assert.deepEqual(refused, { 'acde:office': 'acde:office: "office" is unsupported on this platform' })
  })

  test('the module reports level, mode, window features and each status', async () => {
    const a = app({ capabilities: { office: true, fs: true }, optional: ['office'], services: ['desk'] })
    const c = check('win32', 'standalone')
    const snapshot = c.snapshot(a, third)
    assert.equal(snapshot.level, API_LEVEL)
    assert.equal(snapshot.mode, 'standalone')
    assert.deepEqual(snapshot.window, { backdrop: 'full' })
    const asked: string[] = []
    const ask = async (name: string) => (asked.push(name), { ...c.status(name, a, third), state: 'denied' as const, reason: 'denied by the user' })
    const live = CapabilityCheck.module(snapshot, ask)
    const module = live.module as {
      level: number
      window: { backdrop: string }
      get(name: string): { state: string; optional: boolean; reason: string }
      list(): { name: string }[]
      request(name: string): Promise<{ state: string }>
    }
    assert.equal(module.level, API_LEVEL)
    assert.deepEqual(module.get('office'), { name: 'office', kind: 'system', state: 'unsupported', reason: 'unsupported on this platform', optional: true })
    assert.equal(module.get('desk').state, 'service-not-running')
    assert.equal(module.get('weather').state, 'not-declared')
    assert.equal(module.get('windows').state, 'shell-only')
    assert.equal((await module.request('office')).state, 'unsupported')
    assert.deepEqual(asked, [], 'only a capability that waits for approval is asked for')
    live.update({ ...c.status('terminal', a, third), state: 'denied', reason: 'denied by the user' })
    assert.equal(module.get('terminal').reason, 'denied by the user')
    const names = module.list().map((s) => s.name)
    for (const name of Manifest.CAPABILITIES) assert.ok(names.includes(name), name)
    assert.ok(names.includes('desk'))
  })

  test('the desktop has every system capability the platform offers', () => {
    const snapshot = check('win32', 'desktop').snapshot(null, system)
    const states = Object.fromEntries(snapshot.statuses.map((s) => [s.name, s.state]))
    assert.equal(states['fs'], 'available')
    assert.equal(states['windows'], 'available')
    assert.equal(states['terminal'], 'available')
    assert.equal(states['network'], 'unsupported')
  })
})

describe('CapabilityCheck and approval', () => {
  test('a supported capability the user denied reports denied by the user and fails the required check', () => {
    const a = app({ capabilities: { launch: true, openFiles: true } })
    const c = check('win32', 'desktop', [], [], { launch: 'denied' })
    assert.deepEqual(c.status('launch', a, third), { name: 'launch', kind: 'system', state: 'denied', reason: 'denied by the user', optional: false })
    assert.deepEqual(c.missing(a, third).map((s) => s.name), ['launch'])
    const refusal = c.refusal(a, third) as Error & { status: number; code: string; capability: string }
    assert.equal(refusal.message, 'Demo: "launch" is denied by the user')
    assert.deepEqual([refusal.status, refusal.code, refusal.capability], [403, 'denied', 'launch'])
    const both = check('win32', 'desktop', [], [], { launch: 'denied' }).refusal(app({ capabilities: { launch: true, office: true } }), third)
    const expected = 'Demo needs "launch" (denied by the user), "office" (not available on Windows host windows); list it in "optional" to run without it'
    assert.equal(both!.message, expected, 'what the platform lacks comes first')
    assert.equal((both as Error & { code: string }).code, 'unsupported_app')
    assert.equal(check('win32', 'desktop', [], [], { network: 'denied' }).status('network', app({ capabilities: { network: true } }), third).state, 'unsupported')
  })

  test('a capability nobody answered yet is not asked or asking, never available', () => {
    const a = app({ capabilities: { terminal: true, launch: true, fs: { roots: ['downloads'] } }, optional: ['terminal', 'fs'] })
    const c = check('win32', 'desktop', [], [], { terminal: 'not-asked', launch: 'asking', 'fs.downloads': 'not-asked' })
    assert.deepEqual(c.status('terminal', a, third), { name: 'terminal', kind: 'system', state: 'not-asked', reason: 'not asked for yet', optional: true })
    assert.deepEqual(c.status('launch', a, third), { name: 'launch', kind: 'system', state: 'asking', reason: "waiting for the user's answer", optional: false })
    assert.equal(c.status('fs.downloads', a, third).state, 'not-asked')
    assert.equal(c.status('fs', a, third).state, 'available')
    assert.equal(c.status('terminal', a, system).state, 'not-asked', 'the host decides who is asked')
    assert.equal(c.status('terminal', null, system).state, 'available', 'the desktop is never asked')
  })

  test('a required capability that is still to be asked does not keep the app from starting', () => {
    const a = app({ capabilities: { launch: true, terminal: true } })
    const c = check('win32', 'desktop', [], [], { launch: 'not-asked', terminal: 'asking' })
    assert.deepEqual(c.missing(a, third), [])
    assert.equal(c.refusal(a, third), null)
    assert.deepEqual(c.refusedModules(a, third), {}, 'the page side says why the module waits')
  })

  test('the live module asks for a capability that was not asked for and keeps the answer', async () => {
    const a = app({ capabilities: { launch: true, terminal: true }, optional: ['launch', 'terminal'] })
    const c = check('win32', 'desktop', [], [], { launch: 'not-asked', terminal: 'asking' })
    const asked: string[] = []
    const deny = async (name: string) => (asked.push(name), { ...c.status(name, a, third), state: 'denied' as const, reason: 'denied by the user' })
    const live = CapabilityCheck.module(c.snapshot(a, third), deny)
    const module = live.module as {
      get(name: string): { state: string }
      list(): { name: string; state: string }[]
      request(name: string): Promise<{ state: string; reason: string }>
    }
    const listed = (name: string) => module.list().find((s) => s.name === name)!.state
    assert.equal(module.get('launch').state, 'not-asked')
    assert.equal(listed('launch'), 'not-asked')
    live.update({ ...c.status('launch', a, third), state: 'asking', reason: "waiting for the user's answer" })
    assert.equal(module.get('launch').state, 'asking')
    assert.equal(listed('launch'), 'asking', 'list() follows the updates')
    assert.equal((await module.request('launch')).reason, 'denied by the user')
    assert.equal(module.get('launch').state, 'denied')
    assert.equal(listed('launch'), 'denied')
    assert.equal((await module.request('terminal')).state, 'denied', 'a request joins the prompt that already waits')
    assert.deepEqual(asked, ['launch', 'terminal'])
    assert.equal((await module.request('launch')).state, 'denied')
    assert.deepEqual(asked, ['launch', 'terminal'], 'an answered capability is not asked again')
  })

  test('an available capability is not asked for', async () => {
    const a = app({ capabilities: { launch: true }, optional: ['launch'] })
    const c = check('win32', 'desktop')
    const asked: string[] = []
    const live = CapabilityCheck.module(c.snapshot(a, third), async (name) => (asked.push(name), c.status(name, a, third)))
    const module = live.module as { request(name: string): Promise<{ state: string }> }
    assert.equal((await module.request('launch')).state, 'available')
    assert.deepEqual(asked, [])
  })
})
