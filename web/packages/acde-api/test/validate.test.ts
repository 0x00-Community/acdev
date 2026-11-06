import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ICON_NAMES, Manifest, type PackageManifest } from '../src/validate.ts'

const assets = new Set(['/app/demo/index.html', '/app/demo/icon.svg', '/app/demo/icon.png'])

function check(icon: string) {
  const manifest: PackageManifest = { apps: [{ id: 'demo', label: 'Demo', icon, entry: '/app/demo/index.html' }], assets: { '/app/demo/': ['web'] } }
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

test('capabilities: acde modules and the package\'s own services are known; other names warn', () => {
  const manifest: PackageManifest = {
    apps: [{ id: 'demo', label: 'Demo', icon: 'app', entry: '/app/demo/index.html', capabilities: { fs: true, network: true, desk: true, weather: true } }],
    assets: { '/app/demo/': ['web'] },
    services: [{ name: 'desk', module: 'dist/services/desk.js' }],
  }
  assert.deepEqual(Manifest.check(manifest, () => true, (url) => assets.has(url)), {
    errors: [],
    warnings: ['app "demo": capability "weather" is not acde\'s: a desktop service of that name must be running'],
  })
})
