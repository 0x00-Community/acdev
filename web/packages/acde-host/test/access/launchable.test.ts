import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Manifest, type AppManifest } from '@dopame/acde-api/manifest'
import type { AppRegistry } from '../../src/apps.ts'
import type { PageBridge } from '../../src/bridge.ts'
import { Launchable } from '../../src/broker/access/launchable.ts'
import { Permissions } from '../../src/broker/access/approval/permissions.ts'

const tool = ((): AppManifest => {
  const parsed = Manifest.app({ id: 'tool', label: 'Tool', icon: 'app', entry: '/t/index.html', capabilities: { terminal: true } })
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

test('a single-app session that lost a required capability ends by naming the app and the capability', async () => {
  const { permissions, launchable, saved } = run({}, true)
  assert.equal(refusal(launchable), null, 'not asked yet: the launch asks')
  const admitted = permissions.admit(tool, origin)
  assert.equal(refusal(launchable), null, 'still startable while the prompt waits')
  permissions.answer(permissions.pending()[0]!.id, true)
  await admitted
  assert.equal(permissions.revoke('tool', 'terminal'), true)
  const error = refusal(launchable)!
  assert.equal(error.message, 'Tool: "terminal" is denied by the user')
  assert.deepEqual([error.status, error.code, error.capability], [403, 'denied', 'terminal'])
  assert.equal(Launchable.ended('tool', error), 'acdert app tool: Tool: "terminal" is denied by the user; acdert app asks for it again the next time it runs')
  assert.deepEqual(saved(), {}, 'the decision is gone, so the next run asks')
  const next = run(saved(), true)
  assert.equal(refusal(next.launchable), null)
  assert.equal(next.permissions.approval(tool, origin, 'terminal'), 'not-asked')
})

test('a denial of an earlier run keeps the app from a desktop but not from acdert app, which asks again', () => {
  const desktop = refusal(run({ 'tool:terminal': 'denied' }, false).launchable)!
  assert.deepEqual([desktop.message, desktop.code], ['Tool: "terminal" is denied by the user', 'denied'])
  assert.equal(refusal(run({ 'tool:terminal': 'denied' }, true).launchable), null)
})

test('an end that is not a denial promises nothing about the next run', () => {
  assert.equal(Launchable.ended('tool', new Error('no app tool')), 'acdert app tool: no app tool')
  const unsupported = Object.assign(new Error('Tool needs "office" (unsupported on this platform)'), { status: 404, code: 'unsupported_app' })
  assert.equal(Launchable.ended('tool', unsupported), 'acdert app tool: Tool needs "office" (unsupported on this platform)')
})
