import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { API_LEVEL as ROOT_LEVEL, SHARED_PLACES as ROOT_PLACES } from '../src/index.js'
import { API_LEVEL, APP_MODULES, APPROVAL_CAPABILITIES, ICON_NAMES, Manifest, SHARED_PLACES, SHELL_MODULES, type PackageManifest } from '../src/validate.ts'

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

test('apiLevel: a package without a level is refused and has to be rebuilt', () => {
  assert.equal(Manifest.apiLevel(undefined), null)
  assert.match(Manifest.UNVERSIONED, new RegExp(`rebuild it with the current acde \\(level ${API_LEVEL}\\)`))
  assert.deepEqual(leveled(undefined), { errors: [Manifest.UNVERSIONED], warnings: [] })
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
  assert.deepEqual([...SHELL_MODULES], ['windows', 'packages', 'session', 'desktops', 'inspect', 'desktop', 'setDefault', 'permissions'])
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

test('shell modules: a third-party app may not declare one, whatever its level', () => {
  const findings = tiered({ apiLevel: undefined, apps: [demo({ windows: true })] })
  assert.ok(findings.errors.includes('app "demo": acde:windows is a shell module: only apps of a desktop package (system apps) may declare it'))
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
  const shell = 'windows, packages, session, desktops, inspect, desktop, setDefault, permissions'
  const message = `desktop "desk": service "assistant": modules lists shell modules (${shell})`
  assert.deepEqual(tiered({ desktops: [desk([{ name: 'assistant', modules: ['fs'] }])], apps: [], services }).errors, [message])
  assert.deepEqual(tiered({ desktops: [desk([{ name: 'assistant', modules: 'session' }])], apps: [], services }).errors, [message])
  assert.deepEqual(tiered({ desktops: [desk([{ modules: [] }])], apps: [], services }).errors, [
    'desktop "desk": services lists service names or {name, modules}',
  ])
  assert.deepEqual(tiered({ desktops: [desk(['ghost'])], apps: [], services }).warnings, ['desktop "desk": no service "ghost" in acde.services'])
})

test('config services: a module path, or {module, modules} with the shell modules the manifest rule accepts', () => {
  assert.deepEqual(Manifest.configServices(undefined), [])
  assert.deepEqual(Manifest.configServices({ desk: 'services/desk.ts', assistant: { module: 'services/a.ts', modules: ['session', 'windows'] }, bare: { module: 'b.ts' } }), [
    { name: 'desk', module: 'services/desk.ts', modules: [] },
    { name: 'assistant', module: 'services/a.ts', modules: ['session', 'windows'] },
    { name: 'bare', module: 'b.ts', modules: [] },
  ])
  const configured = Manifest.configServices({ assistant: { module: 'a.ts', modules: ['windows'] } }) as { name: string; modules: string[] }[]
  assert.deepEqual(Manifest.desktopServices(configured.map(({ name, modules }) => ({ name, modules }))), [{ name: 'assistant', modules: ['windows'] }])
})

test('config services: what is refused, modules in the words of the manifest rule', () => {
  const shell = 'windows, packages, session, desktops, inspect, desktop, setDefault, permissions'
  const modules = `service "assistant": modules lists shell modules (${shell})`
  assert.equal(Manifest.configServices({ assistant: { module: 'a.ts', modules: ['fs'] } }), modules)
  assert.equal(Manifest.configServices({ assistant: { module: 'a.ts', modules: 'windows' } }), modules)
  assert.equal(Manifest.configServices({ assistant: { module: 'a.ts', modules: null } }), modules)
  assert.equal(Manifest.desktopServices([{ name: 'assistant', modules: ['fs'] }]), modules)
  const shape = 'service "assistant": a service is its module or {module, modules}'
  for (const entry of [{ modules: ['windows'] }, { module: '' }, { module: 3 }, '', 3, null, ['a.ts']]) assert.equal(Manifest.configServices({ assistant: entry }), shape, JSON.stringify(entry))
  assert.equal(Manifest.configServices({ assistant: { module: 'a.ts', shell: ['windows'] } }), 'service "assistant": "shell" is not a field of a service (module, modules)')
  for (const raw of [['assistant'], 'assistant', 3]) assert.equal(Manifest.configServices(raw), 'services maps each service name to its module or {module, modules}')
})

test('the config schema gives a desktop service the two forms, with the shell modules by name', () => {
  type Form = { type: string; properties?: { module: { type: string }; modules: { type: string; items: { enum: string[] } } }; required?: string[]; additionalProperties?: boolean }
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as {
    oneOf: { properties: { type: { const: string }; services: { type: string; additionalProperties?: { oneOf: Form[] } } } }[]
  }
  const desktop = schema.oneOf.find((branch) => branch.properties.type.const === 'desktop')!
  const [path, granted] = desktop.properties.services.additionalProperties!.oneOf
  assert.equal(path!.type, 'string')
  assert.equal(granted!.type, 'object')
  assert.equal(granted!.properties!.module.type, 'string')
  assert.deepEqual(granted!.properties!.modules.items.enum, [...SHELL_MODULES])
  assert.deepEqual(granted!.required, ['module'])
  assert.equal(granted!.additionalProperties, false)
})

test('schemes: lower-case URL schemes the app opens links for', () => {
  const app = (schemes: unknown) => Manifest.app({ id: 'web', label: 'Web', icon: 'globe', entry: '/app/web/index.html', schemes })
  assert.deepEqual((app(['https', 'http', 'mailto', 'web+notes']) as { schemes: readonly string[] }).schemes, ['https', 'http', 'mailto', 'web+notes'])
  assert.deepEqual((app(undefined) as { schemes: readonly string[] }).schemes, [])
  for (const bad of [['HTTPS'], ['https:'], ['1http'], ['file'], [''], 'https', [7]]) {
    assert.match(String(app(bad)), /schemes/, JSON.stringify(bad))
  }
})
test('requests: the private request kinds an app accepts', () => {
  const app = (requests: unknown) => Manifest.app({ id: 'board', label: 'Board', icon: 'app', entry: '/app/board/index.html', requests })
  assert.deepEqual((app(['task', 'add-note']) as { requests: readonly string[] }).requests, ['task', 'add-note'])
  assert.deepEqual((app(undefined) as { requests: readonly string[] }).requests, [])
  for (const bad of [['Task'], ['open-file'], ['open-link'], [''], ['a b'], 'task', [1]]) {
    assert.match(String(app(bad)), /requests/, JSON.stringify(bad))
  }
})
test('capabilities that reach outside the app need approval; the rest are granted on declaration', () => {
  assert.deepEqual([...APPROVAL_CAPABILITIES], ['launch', 'slots', 'terminal', 'network', 'camera', 'microphone'])
  for (const name of APPROVAL_CAPABILITIES) assert.ok(Manifest.CAPABILITIES.has(name), name)
  for (const name of ['office', 'open', 'openFiles', 'fs']) assert.ok(!(APPROVAL_CAPABILITIES as readonly string[]).includes(name), name)
})

test('a system app may declare acde:permissions; a third-party app may not', () => {
  const settings = { id: 'settings', label: 'Settings', icon: 'app', entry: '/s/index.html', capabilities: { permissions: true } }
  const parsed = Manifest.app(settings)
  assert.equal(typeof parsed, 'object')
  assert.deepEqual(Manifest.shellModules((parsed as { capabilities: Record<string, unknown> }).capabilities), ['permissions'])
})

test('shared places follow the XDG user directories and are asked for one by one', () => {
  assert.deepEqual([...SHARED_PLACES], ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'])
  assert.deepEqual([...ROOT_PLACES], [...SHARED_PLACES])
  assert.deepEqual(Manifest.places({ fs: { roots: ['documents', 'pictures'] } }), ['documents', 'pictures'])
  assert.deepEqual(Manifest.places({ fs: true }), [])
  assert.deepEqual(Manifest.places({}), [])
  assert.equal(Manifest.place('fs.documents'), 'documents')
  assert.equal(Manifest.place('fs.agentos-work'), null)
  assert.equal(Manifest.place('documents'), null)
})

test('fs.roots: a level 1 app names shared places; anything else is an error', () => {
  assert.deepEqual(tiered({ apps: [demo({ fs: { roots: ['documents', 'downloads'] } })] }), { errors: [], warnings: [] })
  assert.deepEqual(tiered({ apps: [demo({ fs: true })] }), { errors: [], warnings: [] })
  const shared = 'desktop, documents, downloads, music, pictures, videos'
  const picked = 'any other folder is one the user picks (showDirectoryPicker() with "fs": true)'
  for (const bad of ['agentos-work', 'nonsense', '下载', '/home/me/Notes', 'C:\\Users\\me', '']) {
    assert.deepEqual(tiered({ apps: [demo({ fs: { roots: [bad] } })] }).errors, [
      `app "demo": fs.roots ${JSON.stringify(bad)} is not a shared place (${shared}); ${picked}`,
    ])
  }
  const named = [
    ['Documents', 'documents'],
    ['~/Downloads', 'downloads'],
    ['/Users/me/Downloads/', 'downloads'],
    ['C:\\Users\\me\\Pictures', 'pictures'],
  ]
  const found = 'the runtime finds that folder through the system (also when it was moved)'
  for (const [bad, place] of named) {
    assert.deepEqual(tiered({ apps: [demo({ fs: { roots: [bad] } })] }).errors, [
      `app "demo": fs.roots ${JSON.stringify(bad)} is not a shared place: write "${place}", ${found}`,
    ])
  }
  assert.deepEqual(tiered({ apps: [demo({ fs: { roots: 'documents' } })] }).errors, [`app "demo": fs.roots lists shared places (${shared})`])
})

test('fs.roots: a path is not a shared place, whatever the level', () => {
  const findings = tiered({ apiLevel: undefined, apps: [demo({ fs: { roots: ['/srv/notes'] } })] })
  assert.ok(findings.errors.some((w) => w.startsWith('app "demo": fs.roots "/srv/notes" is not a shared place')), JSON.stringify(findings))
})

test('a desktop manifest has no frame field', () => {
  const findings = tiered({ desktops: [{ ...(desk([]) as object), frame: false } as never], apps: [] })
  assert.ok(findings.errors.some((e) => e.endsWith('frame is not a desktop field (only apps have a frame)')), JSON.stringify(findings))
})
