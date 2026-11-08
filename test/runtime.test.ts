import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Frameworks } from '../src/frameworks.ts'
import { Jsonc, Runtime } from '../src/runtime.ts'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

describe('Jsonc', () => {
  test('comments and trailing commas; strings keep // and /* and ,}', () => {
    const text = `{
  // a comment
  "type": "app", /* block
  comment */ "url": "http://x/*y*/",
  "list": [1, 2, 3,],
  "odd": "a,} \\" // b",
  "nested": { "a": [ { "b": 1, }, ], },
}
`
    expect(Jsonc.parse(text)).toEqual({ type: 'app', url: 'http://x/*y*/', list: [1, 2, 3], odd: 'a,} " // b', nested: { a: [{ b: 1 }] } })
  })

  test('what JSON rejects still fails', () => {
    expect(() => Jsonc.parse('{ "a": }')).toThrow()
  })

  test('the templates parse', () => {
    for (const name of ['app', 'desktop', 'framework']) {
      const config = Jsonc.parse(readFileSync(join(import.meta.dir, '../templates', name, 'acde.config.jsonc'), 'utf8')) as { type: string }
      expect(['app', 'desktop']).toContain(config.type)
    }
  })
})

describe('Runtime.resolve (the import conditions, from a directory)', () => {
  const root = tmp()
  const put = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put('node_modules/esm-only/package.json', JSON.stringify({ name: 'esm-only', exports: { '.': { types: './x.d.ts', import: './dist/index.js' }, './package.json': './package.json', './sub/*': { import: './dist/sub/*.mjs' } } }))
  put('node_modules/esm-only/dist/index.js', '')
  put('node_modules/esm-only/dist/sub/a.mjs', '')
  put('node_modules/@scope/old/package.json', JSON.stringify({ name: '@scope/old', main: 'lib/main' }))
  put('node_modules/@scope/old/lib/main.js', '')
  put('node_modules/conditional/package.json', JSON.stringify({ exports: { node: { import: './node.mjs', require: './node.cjs' }, default: './browser.js' } }))
  put('node_modules/conditional/node.mjs', '')
  put('app/src/.keep', '')
  const real = realpathSync(root)

  test('exports with import, subpath patterns, main without extension, nested conditions; walks up', () => {
    expect(Runtime.resolve('esm-only', join(root, 'app/src'))).toBe(join(real, 'node_modules/esm-only/dist/index.js'))
    expect(Runtime.resolve('esm-only/sub/a', root)).toBe(join(real, 'node_modules/esm-only/dist/sub/a.mjs'))
    expect(Runtime.resolve('esm-only/package.json', root)).toBe(join(real, 'node_modules/esm-only/package.json'))
    expect(Runtime.resolve('@scope/old', root)).toBe(join(real, 'node_modules/@scope/old/lib/main.js'))
    expect(Runtime.resolve('conditional', root)).toBe(join(real, 'node_modules/conditional/node.mjs'))
  })

  test('missing', () => {
    expect(() => Runtime.resolve('nothing-here', root)).toThrow('cannot find nothing-here')
  })
})

describe('Runtime.spawn / which', () => {
  test('exit codes, a signal is 128 + its number, a missing program rejects', async () => {
    expect(await Runtime.spawn([process.execPath, '-e', 'process.exit(3)'], { stdio: 'ignore' }).exited).toBe(3)
    const child = Runtime.spawn([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })
    child.kill('SIGTERM')
    expect(await child.exited).toBe(143)
    await expect(Runtime.spawn(['/no/such/program'], { stdio: 'ignore' }).exited).rejects.toThrow()
    expect(Runtime.which('sh')).toMatch(/\/sh$/)
    expect(Runtime.which('surely-not-a-program-acde')).toBeNull()
  })
})

describe('Frameworks.detect', () => {
  const pkg = { devDependencies: { vite: '8' } }
  test('vite is the framework unless the config names an entry (then acde builds it; on Node with that vite)', () => {
    expect(Frameworks.detect({ dir: '/', pkg })?.name).toBe('vite')
    expect(Frameworks.detect({ dir: '/', pkg, entry: true })).toBeNull()
    expect(Frameworks.detect({ dir: '/', pkg, entry: true }, 'vite')?.name).toBe('vite')
    expect(Frameworks.detect({ dir: '/', pkg: { dependencies: { next: '16', vite: '8' } }, entry: true })?.name).toBe('next')
  })
})
