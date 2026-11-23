import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AssetUrls } from '../../src/bundler.ts'
import { cleanup, collect, env, tmp } from '../helpers.ts'

afterAll(cleanup)

describe('new URL(path, import.meta.url) in Bun builds', () => {
  test('a relative file that exists becomes a file import; code, missing files and other URLs stay', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'pic.png'), 'png')
    writeFileSync(join(dir, 'worker.js'), '')
    const file = join(dir, 'main.ts')
    const source = [
      "const a = new URL('./pic.png', import.meta.url)",
      'const b = new URL("./missing.png", import.meta.url)',
      "const c = new URL('./worker.js', import.meta.url)",
      "const d = new URL('https://example.com/x.png', import.meta.url)",
    ].join('\n')
    const out = AssetUrls.rewrite(source, file)!
    expect(out.split('\n')).toHaveLength(4)
    expect(out).toStartWith(`import __acdeAssetUrl0 from "./pic.png" with { type: 'file' }; const a = new URL(__acdeAssetUrl0, import.meta.url)`)
    expect(out).toContain('new URL("./missing.png", import.meta.url)')
    expect(out).toContain("new URL('./worker.js', import.meta.url)")
    expect(AssetUrls.rewrite('const x = 1', file)).toBeNull()
    expect(AssetUrls.loader('a.tsx')).toBe('tsx')
    expect(AssetUrls.loader('a.mjs')).toBe('js')
  })

  test('acdev build copies the file and points the URL at it', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/pic.png'), 'png')
    writeFileSync(join(dir, 'src/main.js'), "document.title = new URL('./pic.png', import.meta.url).pathname\n")
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><script type="module" src="./src/main.js"></script>\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'urls', type: 'module' }))
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'urls', label: 'urls', icon: 'application-x-executable' }))
    const out = join(tmp(), 'out')
    const built = await collect([process.execPath, join(import.meta.dir, '../../src/cli.ts'), 'build', '--out', out], { cwd: dir, env: env({}) })
    expect(built.code, built.stderr).toBe(0)
    const files = readdirSync(join(out, 'web'))
    const png = files.find((f) => f.endsWith('.png'))!
    expect(png).toBeDefined()
    const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'web', f), 'utf8')).join('')
    expect(js).toContain(`/app/urls/${png}`)
  }, 60_000)
})
