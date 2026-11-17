import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, collect, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

function cli(args: string[], cwd: string) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env({}) })
}

function project(files: Record<string, string>): string {
  const dir = tmp()
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), data)
  }
  return dir
}

afterAll(cleanup)

describe('errors in the source say where they are', () => {
  test('a syntax error names the file, line and column, with the line', async () => {
    const dir = project({
      'package.json': '{"name": "broken"}',
      'index.html': '<!doctype html><script type="module" src="./src/main.js"></script>',
      'src/main.js': 'const ok = 1\nconst broken = ;\n',
    })
    const result = await cli(['build', '--out', join(dir, '.acde')], dir)
    expect(result.code).toBe(1)
    const said = `${join('src', 'main.js')}:2:16: Unexpected ;`
    expect(result.stderr).toContain(`${said}\n  const broken = ;\n                 ^`)
  })

  test('a broken acde.config.jsonc names the file, line and column', async () => {
    const dir = project({
      'acde.config.jsonc': '{\n  // an app\n  "type": "app",\n  "id": "x"}\n}\n',
      'index.html': '<!doctype html><p>x</p>',
    })
    const result = await cli(['check'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('acde.config.jsonc:5:1: not valid JSON')
    expect(result.stderr).toContain('\n  }\n  ^')
  })
})

describe('development builds keep the source', () => {
  test('acdev dev builds are not minified and carry source maps; acdev build stays minified without them', async () => {
    const { AppPackage } = await import('../src/package.ts')
    const dir = project({
      'package.json': '{"name": "mapped"}',
      'index.html': '<!doctype html><script type="module" src="./src/main.js"></script>',
      'src/main.js': 'export function explode(thing) {\n  return thing.foo.bar\n}\nexplode({})\n',
      'server.ts': 'export default { fetch() { return new Response("ok") } }\n',
    })
    const read = (out: string, sub: string) => {
      const files = readdirSync(join(out, sub))
      return { files, text: files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, sub, f), 'utf8')) }
    }
    const dev = join(dir, '.acde-dev')
    await new AppPackage(dir).build(dev, { dev: true })
    const web = read(dev, 'web')
    expect(web.files.some((f) => f.endsWith('.js.map'))).toBe(true)
    expect(web.text.join('\n')).toContain('function explode(thing)')
    expect(readFileSync(join(dev, 'backend', 'server.js'), 'utf8')).toContain('sourceMappingURL=data:')
    const release = join(dir, '.acde')
    await new AppPackage(dir).build(release)
    const shipped = read(release, 'web')
    expect(shipped.files.some((f) => f.endsWith('.map'))).toBe(false)
    expect(shipped.text.join('\n')).not.toContain('function explode(thing)')
    expect(readFileSync(join(release, 'backend', 'server.js'), 'utf8')).not.toContain('sourceMappingURL')
  }, 60_000)
})

describe('a desktop config with apps that are not objects', () => {
  test('check names the entry instead of crashing', async () => {
    for (const [apps, said] of [
      ['["caps"]', 'acde.config.jsonc: apps[0] is "caps": each app is an object with an "id"'],
      ['[{ "label": "Caps" }]', 'acde.config.jsonc: apps[0] has no "id" (a string)'],
      ['"caps"', 'acde.config.jsonc: "apps" is a list of app objects'],
    ] as const) {
      const dir = project({
        'acde.config.jsonc': `{ "type": "desktop", "id": "desk", "entry": "index.html", "apps": ${apps} }`,
        'index.html': '<!doctype html><p>x</p>',
      })
      const result = await cli(['check'], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(said)
      expect(result.stderr).not.toContain('paths[')
    }
  })
})
