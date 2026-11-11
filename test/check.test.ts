import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sdk } from '../src/sdk.ts'
import { cleanup, collect, env, sdkMirror, tmp } from './helpers.ts'

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

  test('check and acde sdk: an SDK on a local path, or not the version this acde pairs with', async () => {
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
      expect(checked.stderr).toContain('run acde sdk update')
    }
    const paired = Sdk.paired()
    const older = 'https://pkgs.dopame.ai/acdert/0.0.7/acde-api-0.0.7.tar.gz'
    write(older)
    const old = await cli(['check'], dir)
    expect(old.code).toBe(0)
    expect(old.stderr).toContain(`@dopame/acde-api is 0.0.7 (${older}), `
      + `but this acde pairs with ${paired}: run acde sdk update`)
    expect((await cli(['sdk'], dir)).stdout).toContain(`project: 0.0.7 (`)
    write(`https://pkgs.dopame.ai/acdert/${paired}/acde-api-${paired}.tar.gz`)
    expect((await cli(['check'], dir)).stderr).toBe('')
    expect((await cli(['sdk'], dir)).stdout.trim().split('\n').at(-1)).toBe('up to date')
  })

  test('acde sdk update points package.json at the paired tarball and installs it', async () => {
    const sdk = sdkMirror()
    try {
      const dir = tmp()
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
      writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
      const old = 'https://pkgs.dopame.ai/acdert/0.0.7/acde-api-0.0.7.tar.gz'
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'old', packageManager: `bun@${process.versions.bun}`, devDependencies: { '@dopame/acde-api': old },
      }, null, 2))
      const updated = await cli(['sdk', 'update'], dir, { ACDERT_DIST: sdk.dist })
      expect(updated.code, updated.out).toBe(0)
      const url = `${sdk.dist}/${sdk.version}/acde-api-${sdk.version}.tar.gz`
      expect(updated.stdout).toContain(`acde: @dopame/acde-api is ${sdk.version} (${url}), installed with bun`)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      expect(pkg.devDependencies['@dopame/acde-api']).toBe(url)
      expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toContain(`acde-api-${sdk.version}.tar.gz`)
      const installed = JSON.parse(readFileSync(join(dir, 'node_modules/@dopame/acde-api/package.json'), 'utf8'))
      expect(installed.version).toBe(sdk.version)
    } finally {
      sdk.stop()
    }
  }, 120_000)
})
