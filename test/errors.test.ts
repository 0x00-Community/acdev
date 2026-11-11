import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
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
