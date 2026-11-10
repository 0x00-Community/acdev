import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as root from '../src/index.js'
import {
  API_LEVEL,
  Manifest,
  PLATFORM_SUPPORT,
  RESERVED_NAMES,
  RUNNING_MODES,
  WEB_CAPABILITIES,
  platformSupport,
  type PackageManifest,
} from '../src/validate.ts'

const assets = new Set(['/app/demo/index.html'])
const check = (app: Record<string, unknown>, extra: Partial<PackageManifest> = {}) =>
  Manifest.check(
    {
      apiLevel: API_LEVEL,
      apps: [{ id: 'demo', label: 'Demo', icon: 'app', entry: '/app/demo/index.html', ...app }],
      assets: { '/app/demo/': ['web'] },
      ...extra,
    } as PackageManifest,
    () => true,
    (url) => assets.has(url),
  )
const parsed = (app: Record<string, unknown>) => Manifest.app({ id: 'demo', label: 'Demo', icon: 'app', entry: '/app/demo/index.html', ...app })

test('system capabilities and services pass without findings', () => {
  const app = { capabilities: { fs: true, network: true, terminal: true, camera: true }, optional: ['network', 'terminal'], services: ['desk'] }
  assert.deepEqual(check(app), { errors: [], warnings: [] })
  const manifest = parsed(app)
  assert.ok(typeof manifest !== 'string')
  assert.deepEqual(manifest.optional, ['network', 'terminal'])
  assert.deepEqual(manifest.services, ['desk'])
})

test('optional and services default to empty lists', () => {
  const manifest = parsed({ capabilities: { fs: true } })
  assert.ok(typeof manifest !== 'string')
  assert.deepEqual(manifest.optional, [])
  assert.deepEqual(manifest.services, [])
})

test('optional: each name must also be in capabilities', () => {
  const message = 'app demo: optional "terminal" is not in capabilities (optional lists declared capabilities that the app can run without)'
  assert.equal(parsed({ capabilities: { fs: true }, optional: ['terminal'] }), message)
  assert.deepEqual(check({ capabilities: { fs: true }, optional: ['terminal'] }).errors, [message])
  assert.equal(parsed({ capabilities: { fs: true }, optional: 'fs' }), 'app demo: optional lists capability names')
})

test('services: a service may not take a system module name', () => {
  for (const name of ['fs', 'window', 'capabilities', 'windows', 'apps']) {
    const message = `app demo: service "${name}" has the name of a system module (acde:${name}); system module names are reserved`
    assert.equal(parsed({ services: [name] }), message, name)
  }
  assert.equal(parsed({ services: ['desk', 3] }), 'app demo: services lists desktop service names')
  for (const name of ['fs', 'launch', 'capabilities', 'windows', 'slots', 'openFiles', 'camera']) assert.ok(RESERVED_NAMES.has(name), name)
})

test('services: a package service may not take a system module name either', () => {
  const findings = check({}, { services: [{ name: 'session', module: 's.js' }] })
  assert.deepEqual(findings.errors, ['service "session" has the name of a system module (acde:session); system module names are reserved'])
})

test('capabilities: a misspelt capability is an error', () => {
  const findings = check({ capabilities: { fss: true } })
  assert.deepEqual(findings.errors, [
    'app "demo": capability "fss" is not a system capability; list desktop services under services',
  ])
})

test('capabilities: a service of the package still under capabilities is a deprecation warning', () => {
  const findings = check({ capabilities: { desk: true } }, { services: [{ name: 'desk', module: 'd.js' }] })
  assert.deepEqual(findings, {
    errors: [],
    warnings: ['app "demo": capability "desk" is a desktop service: move it to services (deprecated under capabilities)'],
  })
})

test('capabilities: a level 0 package only gets a warning for an unknown name', () => {
  const findings = check({ capabilities: { weather: true } }, { apiLevel: undefined })
  assert.deepEqual(findings.errors, [])
  assert.ok(findings.warnings.includes('app "demo": capability "weather" is not a system capability; list desktop services under services'))
})

test('the platform table is keyed by platform and running mode', () => {
  assert.deepEqual([...RUNNING_MODES], ['session', 'desktop', 'standalone'])
  assert.deepEqual(Object.keys(PLATFORM_SUPPORT).sort(), ['darwin', 'linux', 'win32'])
  assert.deepEqual(Object.keys(PLATFORM_SUPPORT.linux), ['session', 'desktop', 'standalone'])
  assert.equal(platformSupport('win32', 'session'), null)
  assert.equal(platformSupport('freebsd', 'desktop'), null)
  for (const mode of ['desktop', 'standalone'] as const) {
    assert.ok(platformSupport('win32', mode)!.unsupported.includes('terminal'))
    assert.ok(platformSupport('linux', mode)!.unsupported.includes('slots'))
    assert.ok(!platformSupport('darwin', mode)!.unsupported.includes('terminal'))
  }
  assert.deepEqual(platformSupport('linux', 'session')!.unsupported, [])
  assert.ok(platformSupport('win32', 'standalone')!.unsupported.includes('notifications'))
  assert.ok(!platformSupport('win32', 'desktop')!.unsupported.includes('notifications'))
  for (const platform of Object.values(PLATFORM_SUPPORT)) {
    for (const row of Object.values(platform)) {
      assert.ok(['full', 'approximated', 'unsupported'].includes(row.window.backdrop))
      for (const name of row.unsupported) assert.ok(Manifest.CAPABILITIES.has(name) || (WEB_CAPABILITIES as readonly string[]).includes(name), name)
    }
  }
})

test('the SDK root exports the same table', () => {
  assert.equal(root.PLATFORM_SUPPORT, PLATFORM_SUPPORT)
  assert.equal(root.platformSupport, platformSupport)
})
