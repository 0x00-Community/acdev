import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from '../launcher.mjs'
import { Pkgs } from '../src/pkgs.ts'
import { Sdk } from '../src/sdk.ts'
import { brokenSdk, cleanup, collect, env, fakePm, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

const OLD = `${Pkgs.ACDEV}/0.0.7/acde-api-0.0.7.tar.gz`

function oldProject(dir = tmp(), fields: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'old', ...fields, devDependencies: { '@acde/api': OLD },
  }, null, 2))
  return dir
}

afterAll(cleanup)

describe('acdev check on a project', () => {
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

  test('check and acdev sdk: an SDK at another path, a tarball, or this acdev\'s own', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'portable' }))
    const write = (spec: string) =>
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'portable',
        devDependencies: { '@acde/api': spec },
      }))
    for (const spec of ['file:/Users/me/acdev/npm/acde-api', `${Pkgs.ACDEV}/0.0.7/acde-api-0.0.7.tar.gz`]) {
      write(spec)
      const checked = await cli(['check'], dir)
      expect(checked.code).toBe(0)
      expect(checked.stderr).toContain(`warning: package.json: @acde/api is ${spec}, but this acdev's SDK is `
        + `${Sdk.spec()}: run acdev sdk update`)
    }
    expect((await cli(['sdk'], dir)).stdout).toContain(`project: 0.0.7 (`)
    write(Sdk.spec())
    expect((await cli(['check'], dir)).stderr).toBe('')
    expect((await cli(['sdk'], dir)).stdout.trim().split('\n').at(-1)).toBe('up to date')
  })

  test('check: package.json names the paired SDK but node_modules holds another one', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'stale' }))
    const paired = Sdk.paired()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'stale', devDependencies: { '@acde/api': Sdk.spec() },
    }))
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    const installed = join(dir, 'node_modules', '@acde', 'api')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@acde/api', version: '0.0.1' }))
    const checked = await cli(['check'], dir)
    expect(checked.code).toBe(0)
    expect(checked.stderr).toContain(`warning: package.json names @acde/api ${paired}, but 0.0.1 is installed: `
      + 'run npm install')
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@acde/api', version: paired }))
    expect((await cli(['check'], dir)).stderr).toBe('')
  })

  test('acdev sdk and acdev check name the same package manager for the install', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'stale' }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stale', devDependencies: { '@acde/api': Sdk.spec() } }))
    writeFileSync(join(dir, 'bun.lock'), '{}')
    const installed = join(dir, 'node_modules', '@acde', 'api')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@acde/api', version: '0.0.1' }))
    const said = `package.json names @acde/api ${Sdk.paired()}, but 0.0.1 is installed: run bun install`
    expect((await cli(['check'], dir)).stderr).toContain(`warning: ${said}`)
    expect((await cli(['sdk'], dir)).stdout.trim().split('\n').at(-1)).toBe(said)
  })

  test('a failing acdev sdk update puts package.json, the lockfile and .npmrc back and says so', async () => {
    const broken = brokenSdk()
    const old = `${Pkgs.ACDEV}/0.0.7/acde-api-0.0.7.tar.gz`
    const project = (pm: string) => {
      const dir = tmp()
      writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'old', packageManager: pm, devDependencies: { '@acde/api': old },
      }, null, 2))
      return dir
    }
    const bun = project(`bun@${process.versions.bun}`)
    writeFileSync(join(bun, 'bun.lock'), 'the old lock\n')
    const before = readFileSync(join(bun, 'package.json'), 'utf8')
    const failed = await cli(['sdk', 'update'], bun, { ACDEV_SDK: broken })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(`so the update to ${Sdk.paired()} was undone: package.json and bun.lock are as `
      + 'before (@acde/api 0.0.7); node_modules may be half updated: run bun install to match them')
    expect(readFileSync(join(bun, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(bun, 'bun.lock'), 'utf8')).toBe('the old lock\n')
    expect(existsSync(join(bun, '.npmrc'))).toBe(false)
    if (!which('npm')) return
    const npm = project('npm@11.0.0')
    const npmFailed = await cli(['sdk', 'update'], npm, { ACDEV_SDK: broken, npm_config_install_links: 'true' })
    expect(npmFailed.code).toBe(1)
    expect(npmFailed.stderr).toContain('package.json are as before (@acde/api 0.0.7)')
    expect(existsSync(join(npm, '.npmrc'))).toBe(false)
    expect(existsSync(join(npm, 'package-lock.json'))).toBe(false)
  }, 120_000)

  test('acdev sdk update changes nothing when the package manager of the project is not on PATH', async () => {
    const dir = oldProject()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'the old lock\n')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const failed = await cli(['sdk', 'update'], dir, { PATH: tmp() })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toBe('acdev: sdk: pnpm is not on PATH, and this project installs with pnpm: nothing was changed\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('the old lock\n')
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  test('acdev sdk update puts back what it can, each file on its own, and names what it could not', async () => {
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
    expect(failed.stderr).toContain(`acdev: sdk: pnpm install exited with 1, and the update to ${Sdk.paired()} could not `
      + 'be undone completely: could not put back package-lock.json (EISDIR')
    expect(failed.stderr).toContain('; package.json and pnpm-lock.yaml are as before (@acde/api 0.0.7); '
      + 'node_modules may be half updated: run pnpm install to match them')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('the old lock\n')
    expect(existsSync(join(dir, 'yarn.lock'))).toBe(false)
  })

  test('acdev sdk update in a workspace member keeps and writes the files where the package manager has them', async () => {
    const root = realpathSync(tmp())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'the old root lock\n')
    const member = oldProject(join(root, 'packages', 'app'))
    const before = readFileSync(join(member, 'package.json'), 'utf8')
    const pnpm = fakePm('pnpm', [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(join(root, 'pnpm-lock.yaml'))}, 'a new root lock\\n')`,
      'process.exit(1)',
    ].join('\n'))
    const failed = await cli(['sdk', 'update'], member, { PATH: pnpm })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain(`package.json and ${join('..', '..', 'pnpm-lock.yaml')} are as before`)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('the old root lock\n')
    expect(readFileSync(join(member, 'package.json'), 'utf8')).toBe(before)
    rmSync(join(root, 'pnpm-lock.yaml'))
    rmSync(join(root, 'pnpm-workspace.yaml'))
    writeFileSync(join(root, 'package-lock.json'), 'the old npm lock\n')
    const npm = (exit: number) => fakePm('npm', [
      "import { writeFileSync } from 'node:fs'",
      'const [command] = process.argv.slice(2)',
      "if (command === '--version') console.log('12.2.2')",
      `else if (command === 'prefix') console.log(${JSON.stringify(root)})`,
      'else {',
      `  writeFileSync(${JSON.stringify(join(root, 'package-lock.json'))}, 'a new npm lock\\n')`,
      `  process.exit(${exit})`,
      '}',
    ].join('\n'))
    const npmFailed = await cli(['sdk', 'update'], member, { PATH: npm(1) })
    expect(npmFailed.code).toBe(1)
    expect(npmFailed.stderr).toContain(`package.json and ${join('..', '..', 'package-lock.json')} are as before`)
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe('the old npm lock\n')
    expect(existsSync(join(root, '.npmrc'))).toBe(false)
    expect(existsSync(join(member, 'package-lock.json'))).toBe(false)
    const updated = await cli(['sdk', 'update'], member, { PATH: npm(0) })
    expect(updated.code, updated.out).toBe(0)
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe('a new npm lock\n')
    expect(existsSync(join(root, '.npmrc'))).toBe(false)
    expect(existsSync(join(member, '.npmrc'))).toBe(false)
  })

  test('acdev sdk update with npm writes this acdev\'s SDK path and no .npmrc', async () => {
    const npm = fakePm('npm', [
      'const [command] = process.argv.slice(2)',
      "if (command === '--version') console.log('11.10.0')",
      "else if (command === 'prefix') console.log(process.cwd())",
    ].join('\n'))
    const dir = oldProject(tmp(), { packageManager: 'npm@11.10.0' })
    const kept = await cli(['sdk', 'update'], dir, { PATH: npm })
    expect(kept.code, kept.out).toBe(0)
    expect(kept.stdout).toBe(`acdev: @acde/api is ${Sdk.paired()} (${Sdk.spec()}), installed with npm\n`)
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
  })

  test('acdev sdk update: a package manager that does not start leaves the project as it was', async () => {
    if (WINDOWS) return
    const dir = oldProject()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'the old lock\n')
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const bin = tmp()
    writeFileSync(join(bin, 'pnpm'), 'not a program', { mode: 0o644 })
    const failed = await cli(['sdk', 'update'], dir, { PATH: bin })
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('acdev: sdk: pnpm install did not start (')
    expect(failed.stderr).toContain(`so the update to ${Sdk.paired()} was undone: package.json and pnpm-lock.yaml are `
      + 'as before (@acde/api 0.0.7)\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  test('acdev sdk update: Ctrl+C stops the install, waits for it and then puts the project back', async () => {
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
    expect(stderr).toBe(`acdev: sdk: interrupted (SIGINT), so the update to ${Sdk.paired()} was undone: package.json and `
      + 'pnpm-lock.yaml are as before (@acde/api 0.0.7); node_modules may be half updated: run pnpm install '
      + 'to match them\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('the old lock\n')
  })

  test('acdev sdk update points package.json at this acdev\'s SDK and installs it', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'old' }))
    const old = `${Pkgs.ACDEV}/0.0.7/acde-api-0.0.7.tar.gz`
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'old', packageManager: `bun@${process.versions.bun}`, devDependencies: { '@acde/api': old },
    }, null, 2))
    const updated = await cli(['sdk', 'update'], dir)
    expect(updated.code, updated.out).toBe(0)
    expect(updated.stdout).toContain(`acdev: @acde/api is ${Sdk.paired()} (${Sdk.spec()}), installed with bun`)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(pkg.devDependencies['@acde/api']).toBe(Sdk.spec())
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules/@acde/api/package.json'), 'utf8'))
    expect(installed.version).toBe(Sdk.paired())
  }, 120_000)
})
