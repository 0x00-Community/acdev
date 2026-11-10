import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { which } from '../launcher.mjs'
import { cleanup, collect, env, skipping, standIn, tmp, WINDOWS } from './helpers.ts'

const ROOT = join(import.meta.dir, '..')
const API = join(ROOT, '../acdert/web/packages/acde-api/dist')
const SDK = '0.0.7'
const FETCHER = which('curl') ?? which('wget')

function run(argv: string[], extra: Record<string, string>, cwd = ROOT) {
  return collect(argv, { cwd, env: env(extra) })
}

function dist(out: string, version: string) {
  return run([process.execPath, 'scripts/dist.ts', '--api', API, '--sdk', SDK, '--version', version, '--out', out], {})
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const NO_INSTALL_SH = skipping(WINDOWS, 'install.sh on Windows: install.ps1 is tested instead')
  || skipping(!FETCHER, 'install.sh needs curl or wget')

describe.skipIf(NO_INSTALL_SH)('dist and install.sh', () => {
  const out = tmp()
  let server: ReturnType<typeof Bun.serve>
  let base: string

  function install(home: string, args: string[] = [], extra: Record<string, string> = {}) {
    return run(['sh', join(out, 'install.sh'), ...args], {
      HOME: home, SHELL: '/bin/zsh', ACDE_DIST: base, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ZDOTDIR: '', ...extra,
    }, home)
  }

  beforeAll(async () => {
    for (const version of ['0.0.1', '0.0.2']) {
      const made = await dist(out, version)
      expect(made.code, made.out).toBe(0)
    }
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const file = join(out, decodeURIComponent(new URL(request.url).pathname))
        if (!existsSync(file) || !lstatSync(file).isFile()) return new Response('not found', { status: 404 })
        return new Response(Bun.file(file))
      },
    })
    base = `http://127.0.0.1:${server.port}`
  }, 300_000)

  afterAll(() => {
    server?.stop(true)
  })

  test('the archive holds bin/acde and lib/acde (bundles, no sources) and lib/acde-api; checksums match', async () => {
    const tarball = join(out, '0.0.2', 'acde-0.0.2.tar.gz')
    const listed = (await run(['tar', '-tzf', tarball], {})).stdout.split('\n')
    for (const path of [
      'acde-0.0.2/bin/acde', 'acde-0.0.2/bin/acde.cmd', 'acde-0.0.2/LICENSE', 'acde-0.0.2/lib/acde/package.json',
      'acde-0.0.2/lib/acde/launcher.mjs', 'acde-0.0.2/lib/acde/dist/cli.js', 'acde-0.0.2/lib/acde/dist/driver/index.js',
      'acde-0.0.2/lib/acde/dist/e2e/index.js', 'acde-0.0.2/lib/acde/templates/app/index.html',
      'acde-0.0.2/lib/acde-api/package.json', 'acde-0.0.2/lib/acde-api/src/index.js',
      'acde-0.0.2/lib/acde/skills/acde/SKILL.md', 'acde-0.0.2/lib/acde/skills/acde/references/reference/cli.md',
    ]) expect(listed).toContain(path)
    expect(readFileSync(join(out, 'install.md'), 'utf8')).toBe(readFileSync(join(ROOT, 'install.md'), 'utf8'))
    expect(listed.some((path) => /\/(bin\/acdert|bin\/app|lib\/acde\/src)\b/.test(path))).toBe(false)
    expect(listed.some((path) => path.endsWith('.map') || path.includes('/._'))).toBe(false)
    expect(listed.some((path) => /\/lib\/acde\/dist\/chunk-\w+\.js$/.test(path))).toBe(true)
    expect(readFileSync(join(out, '0.0.2', 'SHA256SUMS'), 'utf8')).toBe(`${sha256(tarball)}  acde-0.0.2.tar.gz\n`)
    expect(readFileSync(join(out, 'latest'), 'utf8')).toBe('0.0.2\n')
  }, 300_000)

  test('install.sh: latest into ~/.acde, current and bin links, PATH in .zshrc once, runtime hints only', async () => {
    const home = tmp()
    const first = await install(home)
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain('installed acde 0.0.2')
    expect(first.out).not.toContain('acdert')
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.2')
    expect(readlinkSync(join(home, '.acde', 'bin'))).toBe('current/bin')
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('\n# acde\nexport PATH="$HOME/.acde/bin:$PATH"\n')
    const again = await install(home, ['--version', '0.0.1'])
    expect(again.code, again.out).toBe(0)
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.1')
    expect(readFileSync(join(home, '.zshrc'), 'utf8').match(/# acde/g)).toHaveLength(1)
  }, 60_000)

  test('install.sh fails early and clearly', async () => {
    const home = tmp()
    expect((await install(home, ['--version', '9.9.9'])).stderr).toContain('is there an acde 9.9.9?')
    expect((await install(home, ['--bogus'])).stderr).toContain('unknown argument: --bogus')
    const tampered = tmp()
    for (const file of ['latest', 'install.sh']) writeFileSync(join(tampered, file), readFileSync(join(out, file)))
    mkdirSync(join(tampered, '0.0.2'))
    writeFileSync(join(tampered, '0.0.2', 'acde-0.0.2.tar.gz'), 'not a tarball')
    writeFileSync(join(tampered, '0.0.2', 'SHA256SUMS'), readFileSync(join(out, '0.0.2', 'SHA256SUMS')))
    const tamperedServer = Bun.serve({
      port: 0,
      fetch(request) {
        const file = join(tampered, new URL(request.url).pathname)
        return existsSync(file) ? new Response(Bun.file(file)) : new Response('not found', { status: 404 })
      },
    })
    try {
      const bad = await install(home, [], { ACDE_DIST: `http://127.0.0.1:${tamperedServer.port}` })
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('does not match its checksum')
      expect(existsSync(join(home, '.acde', 'current'))).toBe(false)
    } finally {
      tamperedServer.stop(true)
    }
  })

  test('bin/acde starts the CLI with bun', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path'])).code).toBe(0)
    const acde = join(home, '.acde', 'bin', 'acde')
    const tools = tmp()
    const usage = await run(['sh', acde], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` })
    expect(usage.code).toBe(1)
    expect(usage.stderr).toContain('usage: acde <command>')
  }, 60_000)

  test('the installed skill is linked through current, so another version brings its own', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path'])).code).toBe(0)
    const acde = join(home, '.acde', 'bin', 'acde')
    const vars = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: '', CLAUDE_CONFIG_DIR: '' }
    mkdirSync(join(home, '.claude'))
    const linked = await run(['sh', acde, 'skills', 'install'], vars)
    expect(linked.code, linked.out).toBe(0)
    const through = join(realpathSync(home), '.acde', 'current', 'lib', 'acde', 'skills', 'acde')
    for (const dest of [join(home, '.agents', 'skills', 'acde'), join(home, '.claude', 'skills', 'acde')]) {
      expect(readlinkSync(dest)).toBe(through)
      expect(realpathSync(dest)).toBe(join(realpathSync(home), '.acde', 'versions', '0.0.2', 'lib', 'acde', 'skills', 'acde'))
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(ROOT, 'skills', 'acde', 'SKILL.md'), 'utf8'))
    }
    expect((await run(['sh', acde, 'skills', 'path'], vars)).stdout.trim()).toBe(through)
    expect((await install(home, ['--version', '0.0.1', '--no-modify-path'])).code).toBe(0)
    expect(realpathSync(join(home, '.claude', 'skills', 'acde')))
      .toBe(join(realpathSync(home), '.acde', 'versions', '0.0.1', 'lib', 'acde', 'skills', 'acde'))
    expect((await run(['sh', acde, 'skills'], vars)).stdout).toContain(`link, current   ${join(home, '.claude', 'skills', 'acde')}`)
  }, 60_000)
})

describe('the release archive and the installed CLI', () => {
  const root = tmp()
  const out = join(root, 'windows distribution')
  let built = false

  beforeAll(async () => {
    const made = await dist(out, '0.0.2')
    expect(made.code, made.out).toBe(0)
    built = true
  }, 300_000)

  afterAll(cleanup)

  test('dist refuses an SDK that is not the pinned one, and a missing SDK', async () => {
    const wrongArgs = ['--api', API, '--sdk', '9.9.9', '--version', '0.0.3', '--out', join(root, 'x')]
    const wrong = await run([process.execPath, 'scripts/dist.ts', ...wrongArgs], {})
    expect(wrong.code).toBe(1)
    expect(wrong.out).toContain('not @dopame/acde-api 9.9.9')
    const missingArgs = ['--api', join(root, 'nope'), '--version', '0.0.3', '--out', join(root, 'x')]
    const missing = await run([process.execPath, 'scripts/dist.ts', ...missingArgs], {})
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('not a built @dopame/acde-api package')
  }, 60_000)

  test('Windows x64: install.ps1 and the installed CLI work in paths containing spaces', async () => {
    expect(built).toBe(true)
    if (process.platform !== 'win32' || process.arch !== 'x64') return
    const home = join(root, 'acde installation')
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const file = Bun.file(join(out, new URL(request.url).pathname))
        return file.exists().then((exists) => exists ? new Response(file) : new Response('not found', { status: 404 }))
      },
    })
    try {
      const powershell = which('pwsh') ?? which('powershell')
      expect(powershell).not.toBeNull()
      const result = await run([
        powershell!, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(out, 'install.ps1'),
        '-NoModifyPath',
      ], { ACDE_DIST: server.url.origin, ACDE_INSTALL: home }, root)
      expect(result.code, result.out).toBe(0)
      expect(result.out).toContain('acde dev needs the Dopame runtime')
    } finally {
      server.stop(true)
    }

    const current = join(home, 'current')
    expect(realpathSync(current)).toBe(realpathSync(join(home, 'versions', '0.0.2')))
    expect(existsSync(join(current, 'bin', 'acdert.exe'))).toBe(false)
    expect(existsSync(join(current, 'lib', 'acde', 'src'))).toBe(false)
    expect(readFileSync(join(current, 'LICENSE'), 'utf8')).toBe(readFileSync(join(ROOT, 'LICENSE'), 'utf8'))
    const entries = join(current, 'lib', 'acde', 'dist')
    const exported = await run([process.execPath, '-e', `
      const names = async (file) => Object.keys(await import(file)).sort().join(',')
      console.log(await names(${JSON.stringify(join(entries, 'driver', 'index.js'))}))
      console.log(await names(${JSON.stringify(join(entries, 'e2e', 'index.js'))}))
    `], {}, root)
    expect(exported.code, exported.out).toBe(0)
    const [driver, test] = exported.stdout.trim().split('\n')
    expect(driver).toContain('Acde,')
    expect(test).toContain('expect')

    const shim = join(current, 'bin', 'acde.cmd')
    const project = join(root, 'hello world')
    const build = join(root, 'build output')
    const withApi = join(root, 'with api')
    const apiBuild = join(root, 'api build')
    const path = [dirname(process.execPath), process.env['PATH']].join(delimiter)
    for (const args of [
      ['new', project, '--yes', '--id', 'hello', '--pm', 'bun'],
      ['check', project],
      ['build', project, '--out', build],
      ['new', withApi, '--template', 'html', '--backend', '--yes', '--id', 'with-api', '--pm', 'bun'],
      ['build', withApi, '--out', apiBuild],
    ]) {
      const ran = await run([shim, ...args], { ACDE_INSTALL: home, PATH: path }, root)
      expect(ran.code, ran.out).toBe(0)
    }
    expect(existsSync(join(build, 'web', 'index.html'))).toBe(true)
    const preload = readFileSync(join(apiBuild, 'backend', 'acde-listen.js'), 'utf8')
    expect(preload).toContain('process.getBuiltinModule')
    expect(preload).toContain('ACDE_APP_SOCKETS')
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    const api = manifest.devDependencies?.['@dopame/acde-api'] ?? ''
    expect(api).toStartWith('file:')
    expect(realpathSync(api.slice('file:'.length))).toBe(realpathSync(join(current, 'lib', 'acde-api')))
  }, 300_000)

  test('acde dev without a runtime says what to do in English, and acde new/check/build need none', async () => {
    const s = standIn()
    const home = tmp()
    const ran = await run([process.execPath, join(ROOT, 'src', 'cli.ts'), 'dev'], {
      ...s.env, ACDERT: '', PATH: `${dirname(process.execPath)}:/nonexistent`,
    }, s.project)
    expect(ran.code).toBe(1)
    expect(ran.out).toContain('acde dev needs the Dopame runtime (acdert)')
    expect(ran.out).toContain('set ACDERT to an acdert binary')
    expect(home).toBeTruthy()
  }, 60_000)
})

