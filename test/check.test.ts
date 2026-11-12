import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from '../launcher.mjs'
import { Pkgs } from '../src/pkgs.ts'
import { Sdk } from '../src/sdk.ts'
import { cleanup, collect, env, sdkMirror, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

const OLD = `${Pkgs.ACDERT}/0.0.7/acde-api-0.0.7.tar.gz`

function oldProject(dir = tmp(), fields: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'old', ...fields, devDependencies: { '@dopame/acde-api': OLD },
  }, null, 2))
  return dir
}

function fakePm(name: string, script: string): string {
  const bin = tmp()
  const entry = join(bin, `${name}.mjs`)
  writeFileSync(entry, script)
  if (WINDOWS) writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
  else {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`,
      { mode: 0o755 })
  }
  return bin
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
    const older = `${Pkgs.ACDERT}/0.0.7/acde-api-0.0.7.tar.gz`
    write(older)
    const old = await cli(['check'], dir)
    expect(old.code).toBe(0)
    expect(old.stderr).toContain(`@dopame/acde-api is 0.0.7 (${older}), `
      + `but this acde pairs with ${paired}: run acde sdk update`)
    expect((await cli(['sdk'], dir)).stdout).toContain(`project: 0.0.7 (`)
    write(`${Pkgs.ACDERT}/${paired}/acde-api-${paired}.tar.gz`)
    expect((await cli(['check'], dir)).stderr).toBe('')
    expect((await cli(['sdk'], dir)).stdout.trim().split('\n').at(-1)).toBe('up to date')
  })

  test('check: package.json names the paired SDK but node_modules holds another one', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'stale' }))
    const paired = Sdk.paired()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'stale', devDependencies: { '@dopame/acde-api': `${Pkgs.ACDERT}/${paired}/acde-api-${paired}.tar.gz` },
    }))
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    const installed = join(dir, 'node_modules', '@dopame', 'acde-api')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@dopame/acde-api', version: '0.0.1' }))
    const checked = await cli(['check'], dir)
    expect(checked.code).toBe(0)
    expect(checked.stderr).toContain(`warning: package.json names @dopame/acde-api ${paired}, but 0.0.1 is installed: `
      + 'run npm install')
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@dopame/acde-api', version: paired }))
    expect((await cli(['check'], dir)).stderr).toBe('')
  })

  test('.npmrc: allow-remote=root is added once, after what is there, and a choice of the user is kept', () => {
    const dir = tmp()
    expect(Sdk.allowRemote(dir)).toBe(true)
    expect(readFileSync(join(dir, '.npmrc'), 'utf8')).toBe('allow-remote=root\n')
    expect(Sdk.allowRemote(dir)).toBe(false)
    const other = tmp()
    writeFileSync(join(other, '.npmrc'), 'registry=https://example.test/')
    Sdk.allowRemote(other)
    expect(readFileSync(join(other, '.npmrc'), 'utf8')).toBe('registry=https://example.test/\nallow-remote=root\n')
    const chosen = tmp()
    writeFileSync(join(chosen, '.npmrc'), 'allow-remote = all\n')
    expect(Sdk.allowRemote(chosen)).toBe(false)
    expect(readFileSync(join(chosen, '.npmrc'), 'utf8')).toBe('allow-remote = all\n')
  })

  test('a failing acde sdk update puts package.json, the lockfile and .npmrc back and says so', async () => {
    const dead = 'http://127.0.0.1:9'
    const old = `${Pkgs.ACDERT}/0.0.7/acde-api-0.0.7.tar.gz`
    const project = (pm: string) => {
      const dir = tmp()
      writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'old', packageManager: pm, devDependencies: { '@dopame/acde-api': old },
      }, null, 2))
      return dir
    }
    const bun = project(`bun@${process.versions.bun}`)
    writeFileSync(join(bun, 'bun.lock'), 'the old lock\n')
    const before = readFileSync(join(bun, 'package.json'), 'utf8')
    const failed = await cli(['sdk', 'update'], bun, { ACDERT_DIST: dead })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(`so the update to ${Sdk.paired()} was undone: package.json and bun.lock are as `
      + 'before (@dopame/acde-api 0.0.7); node_modules may be half updated: run bun install to match them')
    expect(readFileSync(join(bun, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(bun, 'bun.lock'), 'utf8')).toBe('the old lock\n')
    expect(existsSync(join(bun, '.npmrc'))).toBe(false)
    if (!which('npm')) return
    const npm = project('npm@11.0.0')
    const npmFailed = await cli(['sdk', 'update'], npm, { ACDERT_DIST: dead, npm_config_fetch_retries: '0' })
    expect(npmFailed.code).toBe(1)
    expect(npmFailed.stderr).toContain('package.json are as before (@dopame/acde-api 0.0.7)')
    expect(existsSync(join(npm, '.npmrc'))).toBe(false)
    expect(existsSync(join(npm, 'package-lock.json'))).toBe(false)
  }, 120_000)

  test('acde sdk update changes nothing when the package manager of the project is not on PATH', async () => {
    const dir = oldProject()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'the old lock\n')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const failed = await cli(['sdk', 'update'], dir, { PATH: tmp() })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toBe('acde: sdk: pnpm is not on PATH, and this project installs with pnpm: nothing was changed\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('the old lock\n')
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  test('acde sdk update puts back what it can, each file on its own, and names what it could not', async () => {
    const dir = oldProject()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'the old lock\n')
    writeFileSync(join(dir, 'package-lock.json'), 'the old npm lock\n')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const bin = fakePm('pnpm', [
      "import { mkdirSync, rmSync, writeFileSync } from 'node:fs'",
      "writeFileSync('pnpm-lock.yaml', 'a new lock\\n')",
      "rmSync('package-lock.json')",
      "mkdirSync('package-lock.json')",
      "writeFileSync('yarn.lock', 'made by the install\\n')",
      'process.exit(1)',
    ].join('\n'))
    const failed = await cli(['sdk', 'update'], dir, { PATH: bin })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(`acde: sdk: pnpm install exited with 1, and the update to ${Sdk.paired()} could not `
      + 'be undone completely: could not put back package-lock.json (EISDIR')
    expect(failed.stderr).toContain('; package.json and pnpm-lock.yaml are as before (@dopame/acde-api 0.0.7); '
      + 'node_modules may be half updated: run pnpm install to match them')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('the old lock\n')
    expect(existsSync(join(dir, 'yarn.lock'))).toBe(false)
  })

  test('acde sdk update: a package manager that does not start leaves the project as it was', async () => {
    if (WINDOWS) return
    const dir = oldProject()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'the old lock\n')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const bin = tmp()
    writeFileSync(join(bin, 'pnpm'), 'not a program', { mode: 0o644 })
    const failed = await cli(['sdk', 'update'], dir, { PATH: bin })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('acde: sdk: pnpm install did not start (')
    expect(failed.stderr).toContain(`so the update to ${Sdk.paired()} was undone: package.json and pnpm-lock.yaml are `
      + 'as before (@dopame/acde-api 0.0.7)\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  test('acde sdk update: Ctrl+C stops the install, waits for it and then puts the project back', async () => {
    if (WINDOWS) return
    const dir = oldProject()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'the old lock\n')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const bin = fakePm('pnpm', [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync('pnpm-lock.yaml', 'a new lock\\n')",
      "process.on('SIGTERM', () => {",
      "  setTimeout(() => {",
      "    writeFileSync('pnpm-lock.yaml', 'written while stopping\\n')",
      '    process.exit(143)',
      '  }, 300)',
      '})',
      "writeFileSync('started', '')",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const child = Bun.spawn([process.execPath, CLI, 'sdk', 'update'], {
      cwd: dir, env: env({ PATH: bin }), stdout: 'pipe', stderr: 'pipe',
    })
    for (let i = 0; i < 200 && !existsSync(join(dir, 'started')); i++) await Bun.sleep(25)
    expect(existsSync(join(dir, 'started'))).toBe(true)
    child.kill('SIGINT')
    expect(await child.exited).toBe(3)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toBe(`acde: sdk: interrupted (SIGINT), so the update to ${Sdk.paired()} was undone: package.json and `
      + 'pnpm-lock.yaml are as before (@dopame/acde-api 0.0.7); node_modules may be half updated: run pnpm install '
      + 'to match them\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('the old lock\n')
  })

  test('acde sdk update points package.json at the paired tarball and installs it', async () => {
    const sdk = sdkMirror()
    try {
      const dir = tmp()
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
      writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
      const old = `${Pkgs.ACDERT}/0.0.7/acde-api-0.0.7.tar.gz`
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
