import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { API_LEVEL as ROOT_LEVEL } from '../src/index.js'
import { API_LEVEL, APP_MODULES, ICON_NAMES, Manifest, SHELL_MODULES, type PackageManifest } from '../src/validate.ts'

const assets = new Set(['/app/demo/index.html', '/app/demo/icon.svg', '/app/demo/icon.png'])

function check(icon: string) {
  const manifest: PackageManifest = {
    apiLevel: API_LEVEL,
    apps: [{ id: 'demo', label: 'Demo', icon, entry: '/app/demo/index.html' }],
    assets: { '/app/demo/': ['web'] },
  }
  return Manifest.check(manifest, () => true, (url) => assets.has(url))
}

test('every icon name passes without findings', () => {
  for (const name of ICON_NAMES) assert.deepEqual(check(name), { errors: [], warnings: [] })
})

test('an image under the assets passes', () => {
  assert.deepEqual(check('/app/demo/icon.svg'), { errors: [], warnings: [] })
  assert.deepEqual(check('/app/demo/icon.png'), { errors: [], warnings: [] })
})

test('an image in no assets directory is an error', () => {
  assert.deepEqual(check('/app/demo/missing.svg'), { errors: ['app "demo": icon "/app/demo/missing.svg" is in no assets directory'], warnings: [] })
})

test('anything else is a warning, and the app still loads', () => {
  for (const icon of ['terminal', 'Files', 'icon.svg', '//cdn.example/icon.svg', '/app/demo/icon.gif', 'https://example.com/a.png']) {
    const { errors, warnings } = check(icon)
    assert.deepEqual(errors, [])
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0]!.startsWith(`app "demo": icon ${JSON.stringify(icon)} is neither an icon name`), String(warnings[0]))
    const app = Manifest.app({ id: 'demo', label: 'Demo', icon, entry: '/app/demo/index.html' })
    assert.equal(typeof app === 'string' ? app : app.icon, icon)
  }
})

test('iconName and iconImage tell the two kinds apart', () => {
  assert.equal(Manifest.iconName('term'), true)
  assert.equal(Manifest.iconName('/app/demo/icon.svg'), false)
  assert.equal(Manifest.iconImage('/app/demo/icon.svg'), true)
  assert.equal(Manifest.iconImage('/app/demo/ICON.PNG'), true)
  assert.equal(Manifest.iconImage('/app/demo/icon.svg?v=1'), false)
  assert.equal(Manifest.iconImage('term'), false)
})

test('the config schema offers the same names', () => {
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as { $defs: { icon: { examples: string[] } } }
  assert.deepEqual(schema.$defs.icon.examples.filter((e) => !e.includes('.')), [...ICON_NAMES])
})

function leveled(apiLevel: unknown) {
  const apps = [{ id: 'demo', label: 'Demo', icon: 'app', entry: '/app/demo/index.html' }]
  const manifest = { apiLevel, apps, assets: { '/app/demo/': ['web'] } } as PackageManifest
  return Manifest.check(manifest, () => true, (url) => assets.has(url))
}

test('the SDK exports one contract level, 1', () => {
  assert.equal(API_LEVEL, 1)
  assert.equal(ROOT_LEVEL, API_LEVEL)
})

test('apiLevel: the runtime level passes', () => {
  assert.equal(Manifest.apiLevel(API_LEVEL), API_LEVEL)
  assert.equal(Manifest.refusal(API_LEVEL), null)
  assert.deepEqual(leveled(API_LEVEL), { errors: [], warnings: [] })
})

test('apiLevel: a missing level still loads as level 0, with a warning', () => {
  assert.equal(Manifest.apiLevel(undefined), null)
  const warning = `acde.apiLevel is missing: acdert still loads it as level 0 but will refuse it; declare apiLevel ${API_LEVEL}`
  assert.deepEqual(leveled(undefined), { errors: [], warnings: [warning] })
})

test('apiLevel: anything but a positive whole number is an error', () => {
  for (const wrong of ['1', 0, -1, 1.5, null, true, [1], Number.NaN]) {
    const message = 'acde.apiLevel must be a positive whole number (the contract level)'
    assert.equal(Manifest.apiLevel(wrong), message, String(wrong))
    assert.deepEqual(leveled(wrong), { errors: [message], warnings: [] }, String(wrong))
  }
})

test('apiLevel: another level is refused with both numbers', () => {
  assert.equal(Manifest.apiLevel(2), 2)
  assert.equal(Manifest.refusal(2), `needs level 2, runtime is level ${API_LEVEL}`)
  assert.deepEqual(leveled(2), { errors: [`acde.apiLevel 2: needs level 2, runtime is level ${API_LEVEL}`], warnings: [] })
})
const tiered = (manifest: Partial<PackageManifest>) =>
  Manifest.check({ apiLevel: API_LEVEL, assets: { '/app/demo/': ['web'] }, ...manifest } as PackageManifest, () => true, (url) => assets.has(url))
const demo = (capabilities: Record<string, unknown>) => ({ id: 'demo', label: 'Demo', icon: 'app', entry: '/app/demo/index.html', capabilities })
const desk = (services: unknown) => ({ id: 'desk', name: 'Desk', entry: 'desk.html', services }) as never

test('modules come in two tiers that do not overlap', () => {
  assert.deepEqual([...SHELL_MODULES], ['windows', 'packages', 'session', 'desktops', 'inspect', 'desktop', 'setDefault'])
  assert.deepEqual([...APP_MODULES], ['launch', 'apps', 'open', 'openPath', 'handlers', 'window'])
  assert.ok(SHELL_MODULES.every((name) => !(APP_MODULES as readonly string[]).includes(name)))
  for (const name of SHELL_MODULES) assert.ok(Manifest.CAPABILITIES.has(name), name)
  assert.deepEqual(Manifest.shellModules({ fs: true, session: true, windows: true, packages: false, desk: true }), ['windows', 'session'])
})

test('shell modules: a system app (in a desktop package) may declare them', () => {
  assert.deepEqual(tiered({ desktops: [desk(undefined)], apps: [demo({ session: true, windows: true })] }), { errors: [], warnings: [] })
})

test('shell modules: a third-party app that declares one is refused', () => {
  const findings = tiered({ apps: [demo({ session: true, fs: true })] })
  assert.deepEqual(findings.errors, ['app "demo": acde:session is a shell module: only apps of a desktop package (system apps) may declare it'])
})

test('shell modules: a level 0 third-party app only gets a warning', () => {
  const findings = tiered({ apiLevel: undefined, apps: [demo({ windows: true })] })
  assert.deepEqual(findings.errors, [])
  assert.ok(findings.warnings.includes('app "demo": acde:windows is a shell module: only apps of a desktop package (system apps) may declare it'))
})

test('desktop services: each lists the shell modules it may use', () => {
  const services = [{ name: 'assistant', module: 'a.js' }, { name: 'desk', module: 'd.js' }]
  const desktops = [desk(['desk', { name: 'assistant', modules: ['session', 'windows'] }])]
  assert.deepEqual(tiered({ desktops, apps: [], services }), { errors: [], warnings: [] })
  assert.deepEqual(Manifest.desktopServices(['desk', { name: 'assistant', modules: ['session'] }]), [
    { name: 'desk', modules: [] },
    { name: 'assistant', modules: ['session'] },
  ])
  assert.equal(Manifest.desktopServices(undefined), null)
})

test('desktop services: modules must be shell modules, services must exist', () => {
  const services = [{ name: 'assistant', module: 'a.js' }]
  const message = 'desktop "desk": service "assistant": modules lists shell modules (windows, packages, session, desktops, inspect, desktop, setDefault)'
  assert.deepEqual(tiered({ desktops: [desk([{ name: 'assistant', modules: ['fs'] }])], apps: [], services }).errors, [message])
  assert.deepEqual(tiered({ desktops: [desk([{ name: 'assistant', modules: 'session' }])], apps: [], services }).errors, [message])
  assert.deepEqual(tiered({ desktops: [desk([{ modules: [] }])], apps: [], services }).errors, [
    'desktop "desk": services lists service names or {name, modules}',
  ])
  assert.deepEqual(tiered({ desktops: [desk(['ghost'])], apps: [], services }).warnings, ['desktop "desk": no service "ghost" in acde.services'])
})
