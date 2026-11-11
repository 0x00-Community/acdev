import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { which } from '../launcher.mjs'
import { systemTar } from '../scripts/shipped.ts'
import { cleanup, collect, env, skipping, standIn, tmp, WINDOWS } from './helpers.ts'

const ROOT = join(import.meta.dir, '..')
const API = process.env['ACDE_TEST_API'] ?? join(ROOT, '../acdert/web/packages/acde-api/dist')
const SDK = (JSON.parse(readFileSync(join(API, 'package.json'), 'utf8')) as { version: string }).version
const FETCHER = which('curl') ?? which('wget')

function run(argv: string[], extra: Record<string, string>, cwd = ROOT) {
  return collect(argv, { cwd, env: env(extra) })
}

function launcher(text = 'MZ stand-in for acde.exe'): string {
  const file = join(tmp(), 'acde.exe')
  writeFileSync(file, text)
  return file
}

function dist(out: string, version: string) {
  const args = ['--api', API, '--sdk', SDK, '--version', version, '--out', out, '--exe', launcher()]
  return run([process.execPath, 'scripts/dist.ts', ...args], {})
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const BUILDS = [
  'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl',
  'x86_64-apple-darwin', 'aarch64-apple-darwin', 'x86_64-pc-windows-msvc',
]

type RuntimeOptions = { builds?: readonly string[]; tamper?: string; omit?: string; bare?: boolean; member?: string }

function runtimeFile(build: string, bare = false): string {
  const windows = build.endsWith('-windows-msvc')
  if (bare) return `acdert-${build}${windows ? '.exe' : ''}`
  return `acdert-${build}${windows ? '.tar.gz' : '.tar.xz'}`
}

function runtimeMirror(dir: string, version: string, options: RuntimeOptions = {}): void {
  const at = join(dir, version)
  const stage = join(at, '.stage')
  mkdirSync(join(stage, 'app', 'dist'), { recursive: true })
  writeFileSync(join(stage, 'app', 'dist', 'broker.js'), 'export {}\n')
  writeFileSync(join(stage, 'app', 'package.json'), '{}\n')
  const host = `acdert-host-${version}.tar.gz`
  const packed = systemTar(['-czf', join(at, host), '-C', stage, 'app'])
  if (packed.status !== 0) throw new Error(`tar: ${packed.stderr}`)
  rmSync(stage, { recursive: true, force: true })
  const files = [host]
  for (const build of options.builds ?? BUILDS) {
    const windows = build.endsWith('-windows-msvc')
    const file = runtimeFile(build, options.bare)
    const script = `#!/bin/sh\necho "acdert ${version} (${build})"\n`
    files.push(file)
    if (options.bare || (WINDOWS && !windows)) {
      writeFileSync(join(at, file), script)
      chmodSync(join(at, file), 0o755)
      continue
    }
    const inner = join(at, `.${build}`)
    const member = options.member ?? (windows ? 'acdert.exe' : 'acdert')
    mkdirSync(inner)
    writeFileSync(join(inner, member), script)
    chmodSync(join(inner, member), 0o755)
    const archived = systemTar([windows ? '-czf' : '-cJf', join(at, file), '-C', inner, member])
    if (archived.status !== 0) throw new Error(`tar: ${archived.stderr}`)
    rmSync(inner, { recursive: true, force: true })
  }
  writeFileSync(join(at, 'SHA256SUMS'), files.map((file) => `${sha256(join(at, file))}  ${file}\n`).join(''))
  if (options.tamper) writeFileSync(join(at, options.tamper), 'changed after the checksum')
  if (options.omit) rmSync(join(at, options.omit))
}

function serve(root: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const file = join(root, decodeURIComponent(new URL(request.url).pathname))
      if (!existsSync(file) || !lstatSync(file).isFile()) return new Response('not found', { status: 404 })
      return new Response(Bun.file(file))
    },
  })
}

const NO_INSTALL_SH =skipping(WINDOWS, 'install.sh on Windows: install.ps1 is tested instead')
  || skipping(!FETCHER, 'install.sh needs curl or wget')

describe.skipIf(NO_INSTALL_SH)('dist and install.sh', () => {
  const out = tmp()
  let server: ReturnType<typeof Bun.serve>
  let base: string

  function install(home: string, args: string[] = [], extra: Record<string, string> = {}) {
    return run(['sh', join(out, 'install.sh'), ...args], {
      HOME: home, SHELL: '/bin/zsh', ACDE_DIST: base, ACDERT_DIST: `${base}/runtime`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ZDOTDIR: '', XDG_CONFIG_HOME: join(home, '.config'), ...extra,
    }, home)
  }

  beforeAll(async () => {
    for (const version of ['0.0.1', '0.0.2']) {
      const made = await dist(out, version)
      expect(made.code, made.out).toBe(0)
    }
    runtimeMirror(join(out, 'runtime'), SDK)
    runtimeMirror(join(out, 'tampered'), SDK, { tamper: `acdert-host-${SDK}.tar.gz` })
    runtimeMirror(join(out, 'missing'), SDK, { omit: `acdert-host-${SDK}.tar.gz` })
    runtimeMirror(join(out, 'elsewhere'), SDK, { builds: ['x86_64-pc-windows-msvc'] })
    runtimeMirror(join(out, 'bare'), SDK, { bare: true })
    runtimeMirror(join(out, 'hollow'), SDK, { member: 'other' })
    server = serve(out)
    base = `http://127.0.0.1:${server.port}`
  }, 300_000)

  afterAll(() => {
    server?.stop(true)
  })

  test('the archive holds bin/acde and lib/acde (bundles, no sources) and lib/acde-api; checksums match', async () => {
    const tarball = join(out, '0.0.2', 'acde-0.0.2.tar.gz')
    const listed = (await run(['tar', '-tzf', tarball], {})).stdout.split('\n')
    for (const path of [
      'acde-0.0.2/bin/acde', 'acde-0.0.2/bin/acde.cmd', 'acde-0.0.2/bin/acde.exe', 'acde-0.0.2/LICENSE',
      'acde-0.0.2/lib/acde/package.json',
      'acde-0.0.2/lib/acde/launcher.mjs', 'acde-0.0.2/lib/acde/dist/cli.js', 'acde-0.0.2/lib/acde/dist/driver/index.js',
      'acde-0.0.2/lib/acde/dist/e2e/index.js', 'acde-0.0.2/lib/acde/templates/app/index.html',
      'acde-0.0.2/lib/acde-api/package.json', 'acde-0.0.2/lib/acde-api/src/index.js',
      'acde-0.0.2/lib/acde/skills/acde/SKILL.md', 'acde-0.0.2/lib/acde/skills/acde/references/reference/cli.md',
    ]) expect(listed).toContain(path)
    expect(readFileSync(join(out, 'install.md'), 'utf8')).toBe(readFileSync(join(ROOT, 'install.md'), 'utf8'))
    expect(listed.some((path) => /\/(bin\/acdert|bin\/app|lib\/acde\/src)\b/.test(path))).toBe(false)
    expect(listed.some((path) => path.endsWith('.map') || path.includes('/._'))).toBe(false)
    expect(listed.some((path) => /\/lib\/acde\/dist\/chunk-\w+\.js$/.test(path))).toBe(true)
    const pairing = join(out, '0.0.2', 'acdert-version')
    expect(readFileSync(pairing, 'utf8')).toBe(`${SDK}\n`)
    expect(readFileSync(join(out, '0.0.2', 'SHA256SUMS'), 'utf8')).toBe(
      `${sha256(pairing)}  acdert-version\n${sha256(tarball)}  acde-0.0.2.tar.gz\n`,
    )
    expect(readFileSync(join(out, 'latest'), 'utf8')).toBe('0.0.2\n')
  }, 300_000)

  test('install.sh: latest and its acdert into ~/.acde, current and bin links, PATH in .zshrc once', async () => {
    const home = tmp()
    const first = await install(home)
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain(`installed acde 0.0.2 with acdert ${SDK}`)
    for (const file of ['acde-0.0.2.tar.gz', `acdert-host-${SDK}.tar.gz`]) {
      expect(first.out, 'no terminal: the size, then a line when done').toContain(`downloading ${file} (`)
      expect(first.out).toContain(`downloaded ${file}`)
      expect(first.out).toContain(`checking ${file} against its SHA256SUMS`)
    }
    expect(first.stdout.trimEnd().split('\n').at(-1)).toBe(`  export PATH="${join(home, '.acde', 'bin')}:$PATH"`)
    const runtime = join(home, '.acde', 'bin', 'acdert')
    expect(statSync(runtime).mode & 0o111).not.toBe(0)
    expect((await run(['sh', runtime], {})).stdout).toStartWith(`acdert ${SDK} (`)
    expect(existsSync(join(home, '.acde', 'bin', 'app', 'dist', 'broker.js'))).toBe(true)
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.2')
    expect(readlinkSync(join(home, '.acde', 'bin'))).toBe('current/bin')
    const line = '\n# acde\nexport PATH="$HOME/.acde/bin:$PATH"\n'
    const startup = ['.zshrc', '.zprofile', '.profile', ...(which('bash') ? ['.bashrc'] : [])]
    for (const file of startup) {
      expect(readFileSync(join(home, file), 'utf8'), file).toBe(line)
      expect(first.out).toContain(`added $HOME/.acde/bin to PATH in ${join(home, file)}`)
    }
    const again = await install(home, ['--version', '0.0.1'])
    expect(again.code, again.out).toBe(0)
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.1')
    for (const file of startup) expect(readFileSync(join(home, file), 'utf8').match(/# acde/g), file).toHaveLength(1)
    if (which('bash')) {
      const login = await run(['bash', '-lc', 'command -v acde'], { HOME: home, PATH: '/usr/bin:/bin' }, home)
      expect(login.stdout.trim(), 'a login bash finds acde').toBe(join(home, '.acde', 'bin', 'acde'))
    }
  }, 60_000)

  test('install.sh: a progress bar in a terminal, none when captured, a line per checked file either way', async () => {
    const captured = await install(tmp(), ['--no-modify-path'])
    expect(captured.code, captured.out).toBe(0)
    expect(captured.out).toMatch(/: acdert-[\w-]+\.tar\.xz: \d+ KB, SHA-256 matches\n/)
    expect(captured.out).toMatch(new RegExp(`: acdert-host-${SDK.replaceAll('.', '\\.')}\\.tar\\.gz: \\d+ KB, SHA-256 matches\n`))
    expect(captured.out).not.toContain('%')
    const home = tmp()
    let shown = ''
    const decoder = new TextDecoder()
    const proc = Bun.spawn(['sh', join(out, 'install.sh'), '--no-modify-path'], {
      cwd: home,
      env: env({
        HOME: home, SHELL: '/bin/zsh', ACDE_DIST: base, ACDERT_DIST: `${base}/runtime`,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ZDOTDIR: '',
      }),
      terminal: { cols: 100, rows: 30, data(_terminal, data) { shown += decoder.decode(data, { stream: true }) } },
    })
    expect(await proc.exited, shown).toBe(0)
    expect(shown).toMatch(/100(\.0)?%/)
    expect(shown).toContain(`installed acde 0.0.2 with acdert ${SDK}`)
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

  test('install.sh: a bad or missing acdert file, or no build here, keeps the previous install', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path', '--version', '0.0.1'])).code).toBe(0)
    const failing: [string, string][] = [
      ['tampered', `acdert-host-${SDK}.tar.gz does not match its checksum`],
      ['missing', `could not download ${base}/missing/${SDK}/acdert-host-${SDK}.tar.gz`],
      ['elsewhere', `acdert ${SDK} has no build for this platform`],
      ['hollow', 'does not hold acdert'],
    ]
    for (const [mirror, said] of failing) {
      const bad = await install(home, ['--no-modify-path'], { ACDERT_DIST: `${base}/${mirror}` })
      expect(bad.code, bad.out).toBe(1)
      expect(bad.stderr).toContain(said)
      expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.1')
      expect(existsSync(join(home, '.acde', 'versions', '0.0.2'))).toBe(false)
    }
    const unsupported = await install(home, ['--no-modify-path'], { ACDERT_DIST: `${base}/elsewhere` })
    expect(unsupported.stderr).toContain('it is built for: x86_64-pc-windows-msvc')
  }, 120_000)

  test('install.sh: an acdert released as a bare binary (0.0.8 and older) still installs', async () => {
    const home = tmp()
    const done = await install(home, ['--no-modify-path'], { ACDERT_DIST: `${base}/bare` })
    expect(done.code, done.out).toBe(0)
    const runtime = join(home, '.acde', 'bin', 'acdert')
    expect(statSync(runtime).mode & 0o111).not.toBe(0)
    expect((await run(['sh', runtime], {})).stdout).toStartWith(`acdert ${SDK} (`)
  }, 60_000)

  test('bin/acde starts the CLI with bun', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path'])).code).toBe(0)
    const acde = join(home, '.acde', 'bin', 'acde')
    const tools = tmp()
    const usage = await run(['sh', acde, '--help'], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` })
    expect(usage.code).toBe(0)
    expect(usage.stdout).toContain('usage: acde <command>')
  }, 60_000)

  test('acde doctor --fix --yes runs the installer again when the acdert next to acde is gone', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path'])).code).toBe(0)
    const runtime = join(home, '.acde', 'versions', '0.0.2', 'bin', 'acdert')
    rmSync(runtime)
    const acde = join(home, '.acde', 'bin', 'acde')
    const vars = {
      HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ACDE_DIST: base, ACDERT_DIST: `${base}/runtime`,
      XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '',
    }
    const does = `run the installer of acde 0.0.2 again (${base}/install.sh), which downloads the acdert this acde pairs with, ` +
      'checks it against SHA256SUMS and puts it next to acde'
    const checked = await run(['sh', acde, 'doctor'], vars, home)
    expect(checked.stdout).toContain(`error  acdert: acde dev needs the Dopame runtime (acdert) and found none: no ${realpathSync(home)}`)
    const asked = await run(['sh', acde, 'doctor', '--fix'], vars, home)
    expect(asked.stdout).toContain(`skipped: ${does} (it asks first: pass --yes to allow it)\n`)
    expect(asked.stdout).toContain('fixed: install the acde skill for the coding agents found here (acde skills install)\n')
    expect(existsSync(runtime)).toBe(false)
    const fixed = await run(['sh', acde, 'doctor', '--fix', '--yes'], vars, home)
    expect(fixed.out).toContain(`installed acde 0.0.2 with acdert ${SDK}`)
    expect(fixed.stdout).toContain(`fixed: ${does}\n`)
    expect(existsSync(runtime)).toBe(true)
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.2')
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
  }, 120_000)

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
    runtimeMirror(join(out, 'runtime'), SDK)
    runtimeMirror(join(out, 'tampered'), SDK, { tamper: 'acdert-x86_64-pc-windows-msvc.tar.gz' })
    runtimeMirror(join(out, 'missing'), SDK, { omit: `acdert-host-${SDK}.tar.gz` })
    runtimeMirror(join(out, 'elsewhere'), SDK, { builds: ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'] })
    runtimeMirror(join(out, 'bare'), SDK, { bare: true })
    runtimeMirror(join(out, 'hollow'), SDK, { member: 'other.exe' })
    built = true
  }, 300_000)

  function installPs1(home: string, runtime: string, extra: Record<string, string> = {}) {
    const powershell = which('pwsh') ?? which('powershell')
    expect(powershell).not.toBeNull()
    return run([
      powershell!, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(out, 'install.ps1'),
      '-NoModifyPath',
    ], { ACDE_INSTALL: home, ACDERT_DIST: `${extra['ACDE_DIST']}/${runtime}`, ...extra }, root)
  }

  afterAll(cleanup)

  test('the version directory names the acdert it pairs with, listed in SHA256SUMS', () => {
    expect(built).toBe(true)
    const pairing = join(out, '0.0.2', 'acdert-version')
    expect(readFileSync(pairing, 'utf8')).toBe(`${SDK}\n`)
    expect(readFileSync(join(out, '0.0.2', 'SHA256SUMS'), 'utf8')).toStartWith(`${sha256(pairing)}  acdert-version\n`)
  })

  test('dist refuses an SDK that is not the pinned one, and a missing SDK', async () => {
    const wrongArgs = ['--api', API, '--sdk', '9.9.9', '--version', '0.0.3', '--out', join(root, 'x')]
    const wrong = await run([process.execPath, 'scripts/dist.ts', ...wrongArgs], {})
    expect(wrong.code).toBe(1)
    expect(wrong.out).toContain('not @dopame/acde-api 9.9.9')
    const missingArgs = ['--api', join(root, 'nope'), '--version', '0.0.3', '--out', join(root, 'x')]
    const missing = await run([process.execPath, 'scripts/dist.ts', ...missingArgs], {})
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('not a built @dopame/acde-api package')
    const script = launcher('#!/bin/sh')
    const notExe = await run([process.execPath, 'scripts/dist.ts', '--api', API, '--sdk', SDK, '--version', '0.0.3',
      '--out', join(root, 'x'), '--exe', script], {})
    expect(notExe.code).toBe(1)
    expect(notExe.out).toContain('not a Windows executable')
  }, 60_000)

  test('Windows x64: install.ps1 and the installed CLI work in paths containing spaces', async () => {
    expect(built).toBe(true)
    if (process.platform !== 'win32' || process.arch !== 'x64') return
    const home = join(root, 'acde installation')
    const server = serve(out)
    try {
      const result = await installPs1(home, 'runtime', { ACDE_DIST: server.url.origin })
      expect(result.code, result.out).toBe(0)
      expect(result.out).toContain(`installed acde 0.0.2 with acdert ${SDK}`)
      expect(result.out).toMatch(/acde: acdert-x86_64-pc-windows-msvc\.tar\.gz: \d+ KB, SHA-256 matches/)
      expect(result.out).toContain(`acde: acdert-host-${SDK}.tar.gz: `)
      const bin = join(home, 'current', 'bin')
      expect(result.stdout.trimEnd().split(/\r?\n/).at(-1)).toBe(`  $env:Path = "${bin};$env:Path"`)
    } finally {
      server.stop(true)
    }

    const current = join(home, 'current')
    expect(realpathSync(current)).toBe(realpathSync(join(home, 'versions', '0.0.2')))
    expect(readFileSync(join(current, 'bin', 'acdert.exe'), 'utf8')).toBe(
      `#!/bin/sh\necho "acdert ${SDK} (x86_64-pc-windows-msvc)"\n`,
    )
    expect(existsSync(join(current, 'bin', 'app', 'dist', 'broker.js'))).toBe(true)
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
      ['new', project, '--yes', '--no-install', '--id', 'hello', '--pm', 'bun'],
      ['check', project],
      ['build', project, '--out', build],
      ['new', withApi, '--template', 'html', '--backend', '--yes', '--no-install', '--id', 'with-api', '--pm', 'bun'],
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
    expect(api).toBe(`https://pkgs.dopame.ai/acdert/${SDK}/acde-api-${SDK}.tar.gz`)
    expect(api).not.toContain(home)
  }, 300_000)

  test('Windows x64: a bad or missing acdert file, or no build for Windows, keeps the previous install', async () => {
    expect(built).toBe(true)
    if (process.platform !== 'win32' || process.arch !== 'x64') return
    const home = join(root, 'kept installation')
    const server = serve(out)
    const dist = { ACDE_DIST: server.url.origin }
    try {
      expect((await installPs1(home, 'runtime', dist)).code).toBe(0)
      const before = readFileSync(join(home, 'current', 'bin', 'acdert.exe'))
      writeFileSync(join(home, 'current', 'marker'), 'kept')
      const failing: [string, string][] = [
        ['tampered', 'checksum mismatch for acdert-x86_64-pc-windows-msvc.tar.gz'],
        ['hollow', `acdert-x86_64-pc-windows-msvc.tar.gz does not hold acdert.exe`],
        ['missing', `could not download ${server.url.origin}/missing/${SDK}/acdert-host-${SDK}.tar.gz`],
        ['elsewhere', `acdert ${SDK} has no build for this platform (x86_64-pc-windows-msvc); ` +
          'it is built for: aarch64-apple-darwin x86_64-unknown-linux-gnu'],
      ]
      for (const [mirror, said] of failing) {
        const bad = await installPs1(home, mirror, dist)
        expect(bad.code, bad.out).not.toBe(0)
        const plain = bad.out.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ')
        expect(plain).toContain(said)
        expect(readFileSync(join(home, 'current', 'marker'), 'utf8')).toBe('kept')
        expect(readFileSync(join(home, 'current', 'bin', 'acdert.exe'))).toEqual(before)
      }
    } finally {
      server.stop(true)
    }
  }, 300_000)

  test('Windows x64: an acdert released as a bare .exe (0.0.8 and older) still installs', async () => {
    expect(built).toBe(true)
    if (process.platform !== 'win32' || process.arch !== 'x64') return
    const home = join(root, 'bare installation')
    const server = serve(out)
    try {
      const result = await installPs1(home, 'bare', { ACDE_DIST: server.url.origin })
      expect(result.code, result.out).toBe(0)
    } finally {
      server.stop(true)
    }
    expect(readFileSync(join(home, 'current', 'bin', 'acdert.exe'), 'utf8')).toBe(
      `#!/bin/sh\necho "acdert ${SDK} (x86_64-pc-windows-msvc)"\n`,
    )
  }, 300_000)

  test('Windows x64: no acdert-version: the sdk of latest.json when it describes that version', async () => {
    expect(built).toBe(true)
    if (process.platform !== 'win32' || process.arch !== 'x64') return
    const old = join(root, 'old release')
    mkdirSync(join(old, '0.0.2'), { recursive: true })
    for (const file of ['install.ps1', 'latest', '0.0.2/acde-0.0.2.tar.gz'])
      writeFileSync(join(old, file), readFileSync(join(out, file)))
    const tarball = join(old, '0.0.2', 'acde-0.0.2.tar.gz')
    writeFileSync(join(old, '0.0.2', 'SHA256SUMS'), `${sha256(tarball)}  acde-0.0.2.tar.gz\n`)
    runtimeMirror(join(old, 'runtime'), SDK)
    const server = serve(old)
    try {
      const home = join(root, 'old installation')
      const refused = await installPs1(home, 'runtime', { ACDE_DIST: server.url.origin })
      expect(refused.code).not.toBe(0)
      expect(refused.out).toContain('acde 0.0.2 does not name the acdert it runs with')
      expect(refused.out).toContain('the oldest version that can is 0.0.8')
      expect(refused.stderr.trim().split(/\r?\n/), 'one line, no PowerShell error record').toHaveLength(1)
      expect(existsSync(join(home, 'current'))).toBe(false)
      writeFileSync(join(old, 'latest.json'), JSON.stringify({ version: '0.0.1', sdk: SDK }, null, 2))
      expect((await installPs1(home, 'runtime', { ACDE_DIST: server.url.origin })).code).not.toBe(0)
      writeFileSync(join(old, 'latest.json'), JSON.stringify({ version: '0.0.2', sdk: SDK }, null, 2))
      const taken = await installPs1(home, 'runtime', { ACDE_DIST: server.url.origin })
      expect(taken.code, taken.out).toBe(0)
      expect(taken.out).toContain(`latest.json pairs it with acdert ${SDK}`)
      expect(existsSync(join(home, 'current', 'bin', 'app', 'dist', 'broker.js'))).toBe(true)
      const last = taken.stdout.trimEnd().split(/\r?\n/).at(-1)
      expect(last).toBe(`  $env:Path = "${join(home, 'current', 'bin')};$env:Path"`)
    } finally {
      server.stop(true)
    }
  }, 180_000)

  test('acde dev without a runtime says what to do in English, and acde new/check/build need none', async () => {
    const s = standIn()
    const home = tmp()
    const ran = await run([process.execPath, join(ROOT, 'src', 'cli.ts'), 'dev'], {
      ...s.env, ACDERT: '', PATH: `${dirname(process.execPath)}:/nonexistent`,
    }, s.project)
    expect(ran.code).toBe(1)
    expect(ran.out).toContain('acde dev needs the Dopame runtime (acdert) and found none')
    expect(ran.out).toContain('set ACDERT to an acdert binary')
    expect(home).toBeTruthy()
  }, 60_000)
})

