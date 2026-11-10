import { afterAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, collect, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

afterAll(cleanup)

describe('acde check on a project', () => {
  test('check: the SDK validator judges the config at level 1 before anything builds', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    const write = (config: object) => writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify(config))
    write({ type: 'app', id: 'lv', capabilities: { fs: { roots: ['/srv'] }, bogus: true, windows: true } })
    const app = await cli(['check'], dir)
    expect(app.code).toBe(1)
    expect(app.stderr).toContain('app "lv": fs.roots "/srv" is not a shared place (desktop, documents')
    expect(app.stderr).toContain('app "lv": capability "bogus" is not a system capability')
    expect(app.stderr).toContain('app "lv": acde:windows is a shell module: only apps of a desktop package')
    write({ type: 'app', id: 'lv', capabilities: {}, services: ['fs'] })
    const reserved = await cli(['check'], dir)
    expect(reserved.code).toBe(1)
    const message = 'service "fs" has the name of a system module (acde:fs); system module names are reserved'
    expect(reserved.stderr.split(message).length).toBe(2)
    const places = { fs: { roots: ['documents'] } }
    write({ type: 'app', id: 'lv', capabilities: places, schemes: ['web+lv'], requests: ['task'] })
    expect((await cli(['check'], dir)).code).toBe(0)
    write({ type: 'desktop', id: 'dk', services: { fs: 'index.html' }, apps: [] })
    expect((await cli(['check'], dir)).stderr).toContain(`error: ${message}`)
    const shell = { id: 'sys', entry: 'index.html', capabilities: { windows: true } }
    write({ type: 'desktop', id: 'dk', apps: [shell] })
    const system = await cli(['check'], dir)
    expect(system.stderr).toBe('')
    expect(system.code).toBe(0)
  })

  test('check warns about an SDK dependency on an absolute local path', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'portable' }))
    const write = (spec: string) =>
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'portable',
        devDependencies: { '@dopame/acde-api': spec },
      }))
    for (const spec of ['file:/Users/me/.acde/current/lib/acde-api', 'file:C:/Users/me/.acde/current/lib/acde-api']) {
      write(spec)
      const checked = await cli(['check'], dir)
      expect(checked.code).toBe(0)
      expect(checked.stderr).toContain(`warning: package.json: @dopame/acde-api is ${spec}, a path on this machine`)
    }
    const portable = ['file:../acdert/web/packages/acde-api',
      'https://pkgs.dopame.ai/acdert/0.0.7/acde-api-0.0.7.tar.gz']
    for (const spec of portable) {
      write(spec)
      expect((await cli(['check'], dir)).stderr).toBe('')
    }
  })
})
