import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Manifest, type AppManifest } from '@dopame/acde-api/manifest'
import type { AppRegistry } from '../../src/apps.ts'
import type { PageBridge } from '../../src/bridge.ts'
import { Launchable } from '../../src/broker/access/launchable.ts'
import { Permissions } from '../../src/broker/access/approval/permissions.ts'

const tool = ((): AppManifest => {
  const parsed = Manifest.app({ id: 'tool', label: 'Tool', icon: 'app', entry: '/t/index.html', capabilities: { camera: true } })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
})()
const origin = { level: 1, system: false }

const run = (saved: Record<string, string>, standalone: boolean) => {
  const store = { read: () => saved, changed: (entries: Record<string, string>) => void (saved = entries), flush: () => {} }
  const permissions = new Permissions({
    store,
    label: () => 'Tool',
    supported: () => true,
    tell: () => {},
    changed: () => {},
    log: () => {},
    asksAgain: () => standalone,
  })
  const apps = { get: (id: string) => (id === 'tool' ? tool : null), origin: () => origin, refusal: () => null } as unknown as AppRegistry
  const launchable = new Launchable({
    platform: 'darwin',
    apps: () => apps,
    hosted: () => true,
    standalone: () => standalone,
    bridge: () => ({ services: { running: () => true }, present: () => true }) as unknown as PageBridge,
    refresh: () => {},
    permissions: () => permissions,
  })
  return { permissions, launchable, saved: () => saved }
}

const refusal = (launchable: Launchable): (Error & { status?: number; code?: string; capability?: string }) | null => {
  try {
    launchable.app('tool')
    return null
  } catch (error) {
    return error as Error
  }
}

test('the camera never keeps an app from starting: not asked, waiting, denied or revoked', async () => {
  const { permissions, launchable, saved } = run({}, true)
  assert.equal(refusal(launchable), null, 'not asked yet: the first use asks')
  const asked = permissions.ask(tool, origin, 'camera', 'request')
  assert.equal(refusal(launchable), null, 'startable while the prompt waits')
  permissions.answer(permissions.pending()[0]!.id, false)
  assert.equal(await asked, false)
  assert.equal(refusal(launchable), null, 'a no only fails getUserMedia')
  assert.equal(permissions.revoke('tool', 'camera'), true)
  assert.equal(refusal(launchable), null)
  assert.deepEqual(saved(), {}, 'the decision is gone, so the next run asks')
})

test('a denial of an earlier run keeps the app neither from a desktop nor from acdert app', () => {
  assert.equal(refusal(run({ 'tool:camera': 'denied' }, false).launchable), null)
  assert.equal(refusal(run({ 'tool:camera': 'denied' }, true).launchable), null)
})

test('an end names the app and the reason', () => {
  assert.equal(Launchable.ended('tool', new Error('no app tool')), 'acdert app tool: no app tool')
  const unsupported = Object.assign(new Error('Tool needs "office" (unsupported on this platform)'), { status: 404, code: 'unsupported_app' })
  assert.equal(Launchable.ended('tool', unsupported), 'acdert app tool: Tool needs "office" (unsupported on this platform)')
})
