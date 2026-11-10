import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { APP_MODULES, CAPABILITY_MODULES, Manifest, SHELL_MODULES, type AppManifest } from '../src/validate.ts'

const app = (capabilities: Record<string, unknown> = {}, services: string[] = []): AppManifest => {
  const parsed = Manifest.app({ id: 'demo', label: 'Demo', icon: 'app', entry: '/demo/index.html', capabilities, services })
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}
const third = { system: false }
const system = { system: true }
const declared = 'the capabilities of Demo'

test('the desktop imports every module', () => {
  for (const name of [...SHELL_MODULES, ...APP_MODULES, ...CAPABILITY_MODULES, 'capabilities', 'anyservice']) {
    assert.deepEqual(Manifest.importRule(name, null, system), { allowed: true, missing: null, reason: null }, name)
  }
})

test('apps, open, window and capabilities need no declaration', () => {
  for (const name of ['apps', 'open', 'window', 'capabilities']) {
    for (const origin of [third, system]) assert.equal(Manifest.importRule(name, app(), origin).allowed, true, name)
  }
})

test('launch needs launch or slots', () => {
  assert.deepEqual(Manifest.importRule('launch', app(), third), {
    allowed: false,
    missing: 'launch',
    reason: `acde:launch needs "launch" or "slots" in ${declared}`,
  })
  assert.equal(Manifest.importRule('launch', app({ launch: true }), third).allowed, true)
  assert.equal(Manifest.importRule('launch', app({ slots: true }), third).allowed, true)
})

test('openPath and handlers need openFiles', () => {
  for (const name of ['openPath', 'handlers']) {
    assert.deepEqual(Manifest.importRule(name, app(), third), { allowed: false, missing: 'openFiles', reason: `acde:${name} needs "openFiles" in ${declared}` })
    assert.equal(Manifest.importRule(name, app({ openFiles: true }), third).allowed, true)
  }
})

test('capability modules need their capability', () => {
  assert.deepEqual([...CAPABILITY_MODULES], ['fs', 'terminal', 'network', 'office'])
  for (const name of CAPABILITY_MODULES) {
    for (const origin of [third, system]) {
      assert.deepEqual(Manifest.importRule(name, app(), origin), { allowed: false, missing: name, reason: `acde:${name} needs "${name}" in ${declared}` })
      assert.equal(Manifest.importRule(name, app({ [name]: true }), origin).allowed, true)
    }
  }
})

test('shell modules: system apps declare them, third-party apps never get them', () => {
  for (const name of SHELL_MODULES) {
    assert.deepEqual(Manifest.importRule(name, app(), system), {
      allowed: false,
      missing: name,
      reason: `acde:${name} is a shell module: declare "${name}" in ${declared}`,
    })
    assert.equal(Manifest.importRule(name, app({ [name]: true }), system).allowed, true)
    for (const caps of [{}, { [name]: true }]) {
      assert.deepEqual(Manifest.importRule(name, app(caps), third), {
        allowed: false,
        missing: null,
        reason: `acde:${name} is a shell module: only the desktop, its services and system apps may import it, and Demo is not a system app`,
      })
    }
  }
})

test('services are imported only when listed under services', () => {
  assert.equal(Manifest.importRule('desk', app({}, ['desk']), third).allowed, true)
  assert.equal(Manifest.importRule('desk', app({ desk: true }), third).allowed, false)
  const reason = 'acde:desk is a desktop service: list "desk" in the services of Demo'
  assert.deepEqual(Manifest.importRule('desk', app(), third), { allowed: false, missing: 'desk', reason })
})

test('every module of either tier has a rule', () => {
  for (const name of [...SHELL_MODULES, ...APP_MODULES, ...CAPABILITY_MODULES]) {
    const rule = Manifest.importRule(name, app(), third)
    assert.equal(typeof rule.allowed, 'boolean', name)
  }
})

test('the config schema carries apiLevel', () => {
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as {
    oneOf: { properties: Record<string, { type?: string; minimum?: number }> }[]
  }
  for (const branch of schema.oneOf) {
    assert.equal(branch.properties['apiLevel']?.type, 'integer')
    assert.equal(branch.properties['apiLevel']?.minimum, 1)
  }
})
