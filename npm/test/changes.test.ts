import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PackageManifest } from '../src/manifest/index.ts'
import * as Changes from '../src/changes.ts'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

function lay(dir: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const PAGE = '<!doctype html><title>a</title><link rel="stylesheet" href="a.css">' +
  '<script type="module" src="a.js"></script><p>hi</p>'

const DOPAME: PackageManifest = {
  apiLevel: 1,
  desktops: [{ id: 'd', name: 'D', entry: 'dist/ui/desktop/index.html' }],
  apps: [{ id: 'files', label: 'Files', icon: 'files', entry: '/ui/files.js' }],
  assets: { '/ui/': ['dist/ui'] },
  services: [{ name: 'desk', module: 'dist/services/desk.js' }],
} as PackageManifest

describe('Changes', () => {
  test('only .css, .js and their maps changed, the page the same without its style and script references: hot', () => {
    const dir = lay(tmp(), { 'web/index.html': PAGE, 'web/a.css': 'p{}', 'web/a.js': 'export {}' })
    const before = Changes.snapshot(dir, ['.'])
    lay(dir, { 'web/a.css': 'p{color:red}', 'web/a.js': 'export const a = 1', 'web/a.js.map': '{}' })
    expect(Changes.reload(before, Changes.snapshot(dir, ['.']), [])).toBe('hot')
  })

  test('renamed bundles: the page differs only in its references, the old file goes and a new one comes: hot', () => {
    const dir = lay(tmp(), { 'index.html': PAGE, 'a.js': 'export {}' })
    const before = Changes.snapshot(dir, ['.'])
    rmSync(join(dir, 'a.js'))
    lay(dir, { 'index.html': PAGE.replace('a.js', 'a-1f2e.js').replace('a.css', 'b.css'), 'a-1f2e.js': 'export {}' })
    expect(Changes.reload(before, Changes.snapshot(dir, ['.']), [])).toBe('hot')
  })

  test('the page itself changed, or another kind of file: full', () => {
    const dir = lay(tmp(), { 'index.html': PAGE, 'logo.svg': '<svg/>' })
    const before = Changes.snapshot(dir, ['.'])
    lay(dir, { 'index.html': PAGE.replace('<p>hi</p>', '<p>bye</p>') })
    expect(Changes.reload(before, Changes.snapshot(dir, ['.']), [])).toBe('full')
    const page = Changes.snapshot(dir, ['.'])
    lay(dir, { 'logo.svg': '<svg></svg>' })
    expect(Changes.reload(page, Changes.snapshot(dir, ['.']), [])).toBe('full')
  })

  test('nothing changed: none; node_modules and .git are not looked at', () => {
    const dir = lay(tmp(), { 'index.html': PAGE, 'node_modules/x/index.js': '1', '.git/HEAD': 'ref' })
    const before = Changes.snapshot(dir, ['.'])
    expect([...before.keys()]).toEqual(['index.html'])
    lay(dir, { 'node_modules/x/index.js': '2' })
    expect(Changes.reload(before, Changes.snapshot(dir, ['.']), [])).toBe('none')
  })

  test('a script of a backend or a service is not swapped in place: full', () => {
    const dir = lay(tmp(), { 'web/a.js': '1', 'backend/server.js': '1', 'services/clock.js': '1' })
    const fixed = ['backend', 'services/clock.js']
    for (const file of ['backend/server.js', 'services/clock.js']) {
      const before = Changes.snapshot(dir, ['.'])
      lay(dir, { [file]: '2' })
      expect(Changes.reload(before, Changes.snapshot(dir, ['.']), fixed)).toBe('full')
    }
  })

  test('page strips scripts, styles and stylesheet links, keeps the rest', () => {
    expect(Changes.page(PAGE)).toBe('<!doctype html><title>a</title><p>hi</p>')
    expect(Changes.page('<link rel="icon" href="i.png"><STYLE>p{}</STYLE>')).toBe('<link rel="icon" href="i.png">')
  })

  test('a hand-written package: what its desktop, assets and services name is served; sources are not', () => {
    const dir = lay(tmp(), {
      'package.json': '{}', 'src/main.ts': 'x', 'dist/ui/desktop/index.html': PAGE, 'dist/ui/files.js': '1',
      'dist/services/desk.js': '1',
    })
    const served = Changes.served(dir, DOPAME, false)
    expect(served).toEqual({ roots: ['dist', 'package.json'], fixed: ['dist/services/desk.js'] })
    const before = Changes.snapshot(dir, served.roots)
    lay(dir, { 'src/main.ts': 'y' })
    expect(Changes.reload(before, Changes.snapshot(dir, served.roots), served.fixed)).toBe('none')
    lay(dir, { 'dist/ui/files.js': '2' })
    expect(Changes.reload(before, Changes.snapshot(dir, served.roots), served.fixed)).toBe('hot')
  })

  test('a hand-written package whose files sit at its root, and a built project, are served whole', () => {
    const dir = lay(tmp(), { 'index.html': PAGE })
    const flat = { ...DOPAME, desktops: [{ id: 'd', name: 'D', entry: 'index.html' }], assets: {}, services: [] }
    expect(Changes.served(dir, flat as PackageManifest, false).roots).toEqual(['.'])
    expect(Changes.served(dir, flat as PackageManifest, true).roots).toEqual(['.'])
  })
})
