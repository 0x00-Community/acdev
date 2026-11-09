import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { which } from '../launcher.mjs'
import { Runtime } from '../src/runtime.ts'
import { cleanup, env, tmp } from './helpers.ts'

const ROOT = join(import.meta.dir, '..')
const TRIPLE = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-` +
  `${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`
const FETCHER = which('curl') ?? which('wget')
const API = join(ROOT, '../acdert/web/packages/acde-api/dist')

function writeHost(host: string, version: string, broker = ''): string {
  mkdirSync(join(host, 'dist'), { recursive: true })
  writeFileSync(join(host, 'dist', 'broker.js'), broker)
  writeFileSync(join(host, 'dist', 'web.js'), '')
  writeFileSync(join(host, 'dist', 'web.js.map'), '')
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'acde-host', version }))
  return host
}

async function run(argv: string[], extra: Record<string, string>, cwd = ROOT) {
  const child = Bun.spawn(argv, { cwd, env: env(extra), stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr, out: stdout + stderr }
}

describe.skipIf(process.platform === 'win32' || !FETCHER)('dist and install.sh', () => {
  const out = tmp()
  const inputs = tmp()
  let server: ReturnType<typeof Bun.serve>
  let base: string

  async function dist(version: string) {
    const made = await run([
      process.execPath, 'scripts/dist.ts', '--acdert', join(inputs, 'acdert'),
      '--host', writeHost(join(inputs, `host-${version}`), version),
      '--triple', TRIPLE, '--version', version, '--out', out,
    ], {})
    expect(made.code, made.out).toBe(0)
  }

  function install(home: string, args: string[] = [], extra: Record<string, string> = {}) {
    return run(['sh', join(out, 'install.sh'), ...args], {
      HOME: home, SHELL: '/bin/zsh', ACDE_DIST: base, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ZDOTDIR: '', ...extra,
    }, home)
  }

  beforeAll(async () => {
    writeFileSync(join(inputs, 'acdert'), '#!/bin/sh\necho fake-acdert "$@"\n', { mode: 0o755 })
    await dist('0.0.1')
    await dist('0.0.2')
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const file = join(out, decodeURIComponent(new URL(request.url).pathname))
        if (!existsSync(file) || !lstatSync(file).isFile()) return new Response('not found', { status: 404 })
        return new Response(Bun.file(file))
      },
    })
    base = `http://127.0.0.1:${server.port}`
  }, 60_000)

  afterAll(() => {
    server?.stop(true)
    cleanup()
  })

  test('the tarball holds bin/, lib/acde (bundles, no sources) and lib/acde-api; checksums match', async () => {
    const name = `acde-0.0.2-${TRIPLE}`
    const tarball = join(out, '0.0.2', `${name}.tar.gz`)
    const listed = (await run(['tar', '-tzf', tarball], {})).stdout.split('\n')
    for (const path of [
      'bin/acde', 'bin/acdert', 'bin/app/dist/broker.js', 'bin/app/dist/web.js', 'lib/acde/package.json',
      'lib/acde/launcher.mjs', 'lib/acde/dist/cli.js', 'lib/acde/dist/driver.js', 'lib/acde/dist/test.js',
      'lib/acde/dist/types/driver/index.d.ts', 'lib/acde/templates/app/index.html', 'lib/acde-api/package.json',
      'lib/acde-api/src/index.js',
    ]) {
      expect(listed).toContain(`${name}/${path}`)
    }
    expect(listed.some((path) => path.endsWith('.js.map') || path.includes('/._'))).toBe(false)
    const sources = listed.filter((path) => /\/lib\/acde(-api)?\/(src|test)\//.test(path))
    expect(sources.every((path) => /\/lib\/acde-api\/src\/[^/]+\.(js|d\.ts)$/.test(path))).toBe(true)
    const cli = (await run(['tar', '-xOzf', tarball, `${name}/lib/acde/dist/cli.js`], {})).stdout
    expect(cli.slice(0, 200)).not.toMatch(/^#!|@bun/m)
    expect(listed.every((path) => !path || path.startsWith(`${name}/`))).toBe(true)
    const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    expect(readFileSync(join(out, '0.0.2', 'SHA256SUMS'), 'utf8')).toBe(`${sum}  ${name}.tar.gz\n`)
    expect(readFileSync(join(out, 'latest'), 'utf8')).toBe('0.0.2\n')
    const windows = await run([
      process.execPath, 'scripts/dist.ts', '--acdert', join(inputs, 'acdert'), '--host', join(inputs, 'host-0.0.2'),
      '--triple', 'x86_64-pc-windows-msvc', '--version', '0.0.2', '--out', out,
    ], {})
    expect(windows.code, windows.out).toBe(0)
    const win = `acde-0.0.2-x86_64-pc-windows-msvc`
    const winListed = (await run(['tar', '-tzf', join(out, '0.0.2', `${win}.tar.gz`)], {})).stdout.split('\n')
    for (const path of ['bin/acde.cmd', 'bin/acdert.exe', 'lib/acde/dist/cli.js']) {
      expect(winListed).toContain(`${win}/${path}`)
    }
    expect(readFileSync(join(out, 'latest'), 'utf8')).toBe('0.0.2\n')
  })

  test('install.sh: latest into ~/.acde, current and bin links, PATH in .zshrc once', async () => {
    const home = tmp()
    const first = await install(home)
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain(`installed acde 0.0.2 (${TRIPLE})`)
    expect(first.out).toContain('next: acde new my-app')
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.2')
    expect(readlinkSync(join(home, '.acde', 'bin'))).toBe('current/bin')
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('\n# acde\nexport PATH="$HOME/.acde/bin:$PATH"\n')
    expect((await run([join(home, '.acde', 'bin', 'acdert'), 'x'], {})).stdout).toBe('fake-acdert x\n')
    const again = await install(home, ['--version', '0.0.1'])
    expect(again.code, again.out).toBe(0)
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.1')
    expect(existsSync(join(home, '.acde', 'versions', '0.0.2', 'bin', 'acde'))).toBe(true)
    expect(readFileSync(join(home, '.zshrc'), 'utf8').match(/# acde/g)).toHaveLength(1)
    const back = await install(home, [], { PATH: `${join(home, '.acde', 'bin')}:/usr/bin:/bin` })
    expect(back.code, back.out).toBe(0)
    expect(readlinkSync(join(home, '.acde', 'current'))).toBe('versions/0.0.2')
    expect(back.out).not.toContain('added')
  }, 30_000)

  test('install.sh: --no-modify-path, ACDE_INSTALL, bash on macOS, fish', async () => {
    const home = tmp()
    const quiet = await install(home, ['--no-modify-path'], { ACDE_INSTALL: join(home, 'elsewhere') })
    expect(quiet.code, quiet.out).toBe(0)
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
    expect(readlinkSync(join(home, 'elsewhere', 'current'))).toBe('versions/0.0.2')
    expect(quiet.out).toContain('is not on PATH')
    const bash = await install(home, [], { SHELL: '/bin/bash' })
    expect(bash.code, bash.out).toBe(0)
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain('export PATH="$HOME/.acde/bin:$PATH"')
    expect(existsSync(join(home, '.bash_profile'))).toBe(process.platform === 'darwin')
    const fish = await install(home, [], { SHELL: '/usr/bin/fish' })
    expect(fish.code, fish.out).toBe(0)
    const fishLine = `fish_add_path -g "${join(home, '.acde', 'bin')}"`
    expect(readFileSync(join(home, '.config/fish/conf.d/acde.fish'), 'utf8')).toBe(`\n# acde\n${fishLine}\n`)
  }, 30_000)

  test('install.sh fails early and clearly', async () => {
    const home = tmp()
    expect((await install(home, ['--version', '9.9.9'])).stderr).toContain('is there an acde 9.9.9?')
    expect((await install(home, ['--bogus'])).stderr).toContain('unknown argument: --bogus')
    const tampered = tmp()
    for (const file of ['latest', 'install.sh']) writeFileSync(join(tampered, file), readFileSync(join(out, file)))
    mkdirSync(join(tampered, '0.0.2'))
    writeFileSync(join(tampered, '0.0.2', `acde-0.0.2-${TRIPLE}.tar.gz`), 'not a tarball')
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

  test('bin/acde: bun 1.4+, else node 22.3+, else says what to update; the launcher finds acdert', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path'])).code).toBe(0)
    const acde = join(home, '.acde', 'bin', 'acde')
    const cliJs = realpathSync(join(home, '.acde', 'versions', '0.0.2', 'lib', 'acde', 'dist', 'cli.js'))
    const tools = tmp()
    symlinkSync(process.execPath, join(tools, 'bun'))
    const usage = await run([acde], { PATH: `${tools}:/usr/bin:/bin` })
    expect(usage.code).toBe(1)
    expect(usage.stderr).toContain('usage: acde <command>')
    const fakes = tmp()
    const nodeFake = '#!/bin/sh\nif [ "$1" = -p ]; then echo "$FAKE_NODE"; else echo "node $*"; fi\n'
    writeFileSync(join(fakes, 'node'), nodeFake, { mode: 0o755 })
    const bunFake = '#!/bin/sh\nif [ "$1" = --version ]; then echo "$FAKE_BUN"; else echo "bun $*"; fi\n'
    writeFileSync(join(fakes, 'bun'), bunFake, { mode: 0o755 })
    const bunOnly = tmp()
    symlinkSync(join(fakes, 'bun'), join(bunOnly, 'bun'))
    const nodeOnly = tmp()
    symlinkSync(join(fakes, 'node'), join(nodeOnly, 'node'))
    const both = `${fakes}:/usr/bin:/bin`
    const bun = await run([acde, 'new', 'x'], { PATH: both, FAKE_BUN: '1.4.0', FAKE_NODE: '24.0.0' })
    expect(bun.stdout).toBe(`bun ${cliJs} new x\n`)
    const node = await run([acde, 'new', 'x'], { PATH: both, FAKE_BUN: '1.3.9', FAKE_NODE: '22.3.0' })
    expect(node.stdout).toBe(`node ${cliJs} new x\n`)
    const oldBun = await run([acde], { PATH: both, FAKE_BUN: '1.3.9', FAKE_NODE: '22.2.0' })
    expect(oldBun.code).toBe(1)
    expect(oldBun.stderr).toContain('needs Bun 1.4 or newer, and the bun on PATH is 1.3.9')
    const badBun = await run([acde], { PATH: `${bunOnly}:/usr/bin:/bin`, FAKE_BUN: '1.2.0' })
    expect(badBun.stderr).toContain('needs Bun 1.4 or newer')
    const oldNode = await run([acde], { PATH: `${nodeOnly}:/usr/bin:/bin`, FAKE_NODE: '20.0.0' })
    expect(oldNode.code).toBe(1)
    expect(oldNode.stderr).toContain('needs Node.js 22.3 or newer, and the node on PATH is 20.0.0')
    const none = await run([acde], { PATH: '/usr/bin:/bin' })
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('needs Bun 1.4+ or Node.js 22.3+ and there is neither on PATH')
    const launcher = join(home, '.acde', 'current', 'lib', 'acde', 'launcher.mjs')
    const script = `const m = await import(${JSON.stringify(launcher)}); console.log(await m.requireAcdert())`
    const found = await run([process.execPath, '-e', script], {
      PATH: '/usr/bin:/bin', ACDE_INSTALL: join(tmp(), 'none'),
    })
    expect(found.stdout.trim()).toBe(join(realpathSync(home), '.acde', 'versions', '0.0.2', 'bin', 'acdert'))
  }, 30_000)
})

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'Windows x64: install.ps1 and the installed CLI work in paths containing spaces',
  async () => {
    const root = tmp()
    const out = join(root, 'windows distribution')
    const host = join(root, 'host files')
    const desktop = join(root, 'desktop package')
    const acdert = join(root, 'acdert.exe')
    const version = '0.0.2'
    writeHost(host, version)
    mkdirSync(join(desktop, 'dist'), { recursive: true })
    writeFileSync(acdert, 'test runtime')
    writeFileSync(join(desktop, 'package.json'), '{"name":"test-desktop","acde":{"apps":[]}}')
    writeFileSync(join(desktop, 'dist', 'index.html'), '<title>Desktop</title>')
    const made = await run([
      process.execPath, 'scripts/dist.ts', '--acdert', acdert, '--host', host, '--desktop', desktop,
      '--api', API, '--triple', 'x86_64-pc-windows-msvc',
      '--out', out, '--version', version,
    ], {})
    expect(made.code, made.out).toBe(0)

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const file = Bun.file(join(out, new URL(request.url).pathname))
        return file.exists().then((exists) => exists ? new Response(file) : new Response('not found', { status: 404 }))
      },
    })
    const home = join(root, 'acde installation')
    try {
      const powershell = which('pwsh') ?? which('powershell')
      expect(powershell).not.toBeNull()
      const result = await run([
        powershell!, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(out, 'install.ps1'),
        '-NoModifyPath',
      ], { ACDE_DIST: server.url.origin, ACDE_INSTALL: home }, root)
      expect(result.code, result.out).toBe(0)
    } finally {
      server.stop(true)
    }

    const current = join(home, 'current')
    expect(realpathSync(current)).toBe(realpathSync(join(home, 'versions', version)))
    expect(readFileSync(join(current, 'bin', 'acdert.exe'), 'utf8')).toBe('test runtime')
    expect(existsSync(join(current, 'bin', 'app', 'dist', 'broker.js'))).toBe(true)
    const shipped = join(current, 'bin', 'app', 'packages', 'desktop package', 'dist', 'index.html')
    expect(readFileSync(shipped, 'utf8')).toBe('<title>Desktop</title>')
    expect(existsSync(join(current, 'lib', 'acde', 'src'))).toBe(false)
    expect(existsSync(join(current, 'lib', 'acde', 'dist', 'cli.js'))).toBe(true)
    expect(existsSync(join(current, 'lib', 'acde', 'dist', 'types', 'driver', 'index.d.ts'))).toBe(true)
    expect(readFileSync(join(current, 'LICENSE'), 'utf8')).toBe(readFileSync(join(ROOT, 'LICENSE'), 'utf8'))
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
    expect(readFileSync(join(current, 'lib', 'acde', 'LICENSE'), 'utf8')).toBe(license)
    const entries = join(current, 'lib', 'acde', 'dist')
    const exported = await run([process.execPath, '-e', `
      const names = async (file) => Object.keys(await import(file)).sort().join(',')
      console.log(await names(${JSON.stringify(join(entries, 'driver.js'))}))
      console.log(await names(${JSON.stringify(join(entries, 'test.js'))}))
    `], {}, root)
    expect(exported.code, exported.out).toBe(0)
    const [driver, test] = exported.stdout.trim().split('\n')
    expect(driver).toContain('Acde,')
    expect(test).toContain('expect')

    const launcher = pathToFileURL(join(current, 'lib', 'acde', 'launcher.mjs')).href
    const found = await run([
      process.execPath, '-e', `const m = await import(${JSON.stringify(launcher)}); console.log(m.requireAcdert())`,
    ], { ACDE_INSTALL: join(root, 'missing') }, root)
    expect(found.code, found.out).toBe(0)
    expect(realpathSync(found.stdout.trim())).toBe(realpathSync(join(current, 'bin', 'acdert.exe')))

    const shim = join(current, 'bin', 'acde.cmd')
    const project = join(root, 'hello world')
    const build = join(root, 'build output')
    const path = [dirname(process.execPath), process.env['PATH']].join(delimiter)
    const withApi = join(root, 'with api')
    const apiBuild = join(root, 'api build')
    for (const args of [
      ['new', project, '--yes', '--id', 'hello', '--pm', 'bun'],
      ['check', project],
      ['build', project, '--out', build],
      ['new', withApi, '--template', 'html', '--backend', '--yes', '--id', 'with-api', '--pm', 'bun'],
      ['build', withApi, '--out', apiBuild],
    ]) {
      const child = Runtime.spawn([shim, ...args], {
        cwd: root, env: env({ ACDE_INSTALL: home, PATH: path }), stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.process.stdout!.on('data', (chunk) => { output += chunk.toString() })
      child.process.stderr!.on('data', (chunk) => { output += chunk.toString() })
      expect(await child.exited, output).toBe(0)
    }
    expect(existsSync(join(build, 'web', 'index.html'))).toBe(true)
    const preload = readFileSync(join(apiBuild, 'backend', 'acde-listen.js'), 'utf8')
    expect(preload).toContain('process.getBuiltinModule')
    expect(preload).toContain('ACDE_APP_SOCKETS')
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
    const api = manifest.devDependencies['@dopame/acde-api']
    expect(api).toStartWith('file:')
    expect(realpathSync(api.slice('file:'.length))).toBe(realpathSync(join(current, 'lib', 'acde-api')))
  },
  180_000,
)

describe('dist refuses a host that is not this release, or that ships maps', () => {
  const root = tmp()
  const acdert = join(root, 'acdert')
  const dist = (host: string, version: string) => run([
    process.execPath, 'scripts/dist.ts', '--acdert', acdert, '--host', host, '--triple', TRIPLE,
    '--version', version, '--api', API, '--out', join(root, 'out'),
  ], {})

  beforeAll(() => writeFileSync(acdert, 'fake acdert'))

  test('a host of another version', async () => {
    const made = await dist(writeHost(join(root, 'old-host'), '0.0.1'), '0.0.2')
    expect(made.code).toBe(1)
    expect(made.out).toContain('only the host of the same release ships')
  }, 60_000)

  test('a host whose bundle still points at a source map', async () => {
    const mapped = writeHost(join(root, 'mapped-host'), '0.0.2', '//# sourceMappingURL=broker.js.map\n')
    const made = await dist(mapped, '0.0.2')
    expect(made.code).toBe(1)
    expect(made.out).toContain('source map reference')
  }, 120_000)
})

afterAll(cleanup)
