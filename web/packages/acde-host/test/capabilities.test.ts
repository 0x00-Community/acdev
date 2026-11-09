import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { API_LEVEL, Manifest, type AppManifest, type RunningMode } from '@dopame/acde-api/manifest'
import { CapabilityCheck, type CapabilityHost } from '../src/broker/access/capabilities.ts'
import type { AppOrigin } from '../src/apps.ts'

const third: AppOrigin = { level: 1, system: false }
const system: AppOrigin = { level: 1, system: true }
const app = (fields: Record<string, unknown>): AppManifest => {
  const parsed = Manifest.app({ id: 'demo', label: 'Demo', icon: 'app', entry: '/demo/index.html', ...fields })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}
const check = (platform: string, mode: RunningMode, running: string[] = [], absent: string[] = []) =>
  new CapabilityCheck({
    platform,
    mode: () => mode,
    running: (service) => running.includes(service),
    present: (capability) => !absent.includes(capability),
  } satisfies CapabilityHost)
const state = (c: CapabilityCheck, name: string, a: AppManifest | null, origin: AppOrigin = third) => c.status(name, a, origin).state

describe('CapabilityCheck', () => {
  test('a capability the table leaves out is unsupported on this platform', () => {
    const terminal = app({ capabilities: { terminal: true } })
    assert.equal(state(check('win32', 'desktop'), 'terminal', terminal), 'unsupported')
    assert.equal(state(check('linux', 'desktop'), 'terminal', terminal), 'available')
    const slots = app({ capabilities: { slots: true } })
    assert.equal(state(check('linux', 'standalone'), 'slots', slots), 'unsupported')
    assert.equal(state(check('linux', 'session'), 'slots', slots), 'available')
    assert.equal(state(check('win32', 'session'), 'fs', app({ capabilities: { fs: true } })), 'unsupported')
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
    const refusal = c.refusal(app({ label: 'Term', capabilities: { terminal: true, fs: true } }), third) as Error & { status: number; code: string }
    assert.equal(refusal.message, 'Term needs "terminal" (unsupported on this platform)')
    assert.equal(refusal.status, 404)
    assert.equal(refusal.code, 'unsupported_app')
    const stopped = c.refusal(app({ label: 'Board', services: ['desk'] }), third) as Error & { status: number; code: string }
    assert.equal(stopped.message, 'Board needs "desk" (service not running)')
    assert.equal(stopped.status, 503)
    assert.equal(c.refusal(app({ capabilities: { terminal: true }, optional: ['terminal'] }), third), null)
    assert.equal(c.refusal(app({ capabilities: { network: true, fs: true } }), third)?.message, 'Demo needs "network" (unsupported on this platform)')
  })

  test('declared but unavailable module capabilities get a refusal reason at import', () => {
    const refused = check('win32', 'desktop').refusedModules(app({ capabilities: { terminal: true, fs: true }, optional: ['terminal'] }), third)
    assert.deepEqual(refused, { 'acde:terminal': 'acde:terminal: "terminal" is unsupported on this platform' })
  })

  test('the module reports level, mode, window features and each status', async () => {
    const a = app({ capabilities: { terminal: true, fs: true }, optional: ['terminal'], services: ['desk'] })
    const c = check('win32', 'standalone')
    const snapshot = c.snapshot(a, third)
    assert.equal(snapshot.level, API_LEVEL)
    assert.equal(snapshot.mode, 'standalone')
    assert.deepEqual(snapshot.window, { backdrop: 'full' })
    const module = CapabilityCheck.module(snapshot) as {
      level: number
      window: { backdrop: string }
      get(name: string): { state: string; optional: boolean; reason: string }
      list(): { name: string }[]
      request(name: string): Promise<{ state: string }>
    }
    assert.equal(module.level, API_LEVEL)
    assert.deepEqual(module.get('terminal'), { name: 'terminal', kind: 'system', state: 'unsupported', reason: 'unsupported on this platform', optional: true })
    assert.equal(module.get('desk').state, 'service-not-running')
    assert.equal(module.get('weather').state, 'not-declared')
    assert.equal(module.get('windows').state, 'shell-only')
    assert.equal((await module.request('terminal')).state, 'unsupported')
    const names = module.list().map((s) => s.name)
    for (const name of Manifest.CAPABILITIES) assert.ok(names.includes(name), name)
    assert.ok(names.includes('desk'))
  })

  test('the desktop has every system capability the platform offers', () => {
    const snapshot = check('win32', 'desktop').snapshot(null, system)
    const states = Object.fromEntries(snapshot.statuses.map((s) => [s.name, s.state]))
    assert.equal(states['fs'], 'available')
    assert.equal(states['windows'], 'available')
    assert.equal(states['terminal'], 'unsupported')
  })
})
