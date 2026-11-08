import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from '../launcher.mjs'
import { cleanup, env, tmp } from './helpers.ts'

const ROOT = join(import.meta.dir, '..')
const TRIPLE = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`
const FETCHER = which('curl') ?? which('wget')

async function run(argv: string[], extra: Record<string, string>, cwd = ROOT) {
  const child = Bun.spawn(argv, { cwd, env: env(extra), stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr, out: stdout + stderr }
}

describe.skipIf(process.platform === 'win32' || !FETCHER)('dist and install.sh', () => {
  const out = tmp()
  const inputs = tmp()
  let server: ReturnType<typeof Bun.serve>
  let base: string

  async function dist(version: string) {
    const made = await run([process.execPath, 'scripts/dist.ts', '--acdert', join(inputs, 'acdert'), '--host', join(inputs, 'host'), '--triple', TRIPLE, '--version', version, '--out', out], {})
    expect(made.code, made.out).toBe(0)
  }

  function install(home: string, args: string[] = [], extra: Record<string, string> = {}) {
    return run(['sh', join(out, 'install.sh'), ...args], { HOME: home, SHELL: '/bin/zsh', ACDE_DIST: base, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ZDOTDIR: '', ...extra }, home)
  }

  beforeAll(async () => {
    writeFileSync(join(inputs, 'acdert'), '#!/bin/sh\necho fake-acdert "$@"\n', { mode: 0o755 })
    mkdirSync(join(inputs, 'host'))
    writeFileSync(join(inputs, 'host', 'broker.js'), '')
    writeFileSync(join(inputs, 'host', 'web.js'), '')
    writeFileSync(join(inputs, 'host', 'web.js.map'), '')
    await dist('0.0.1')
    await dist('0.0.2')
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const file = join(out, decodeURIComponent(new URL(request.url).pathname))
        return existsSync(file) && lstatSync(file).isFile() ? new Response(Bun.file(file)) : new Response('not found', { status: 404 })
      },
    })
    base = `http://127.0.0.1:${server.port}`
  }, 60_000)

  afterAll(() => {
    server?.stop(true)
    cleanup()
  })

  test('the tarball holds bin/ (shim, acdert, host bundle) and lib/ (acde, acde-api); SHA256SUMS and latest match', async () => {
    const name = `acde-0.0.2-${TRIPLE}`
    const tarball = join(out, '0.0.2', `${name}.tar.gz`)
    const listed = (await run(['tar', '-tzf', tarball], {})).stdout.split('\n')
    for (const path of ['bin/acde', 'bin/acdert', 'bin/app/dist/broker.js', 'bin/app/dist/web.js', 'lib/acde/package.json', 'lib/acde/launcher.mjs', 'lib/acde/src/cli.js', 'lib/acde/src/listen.ts', 'lib/acde/templates/app/index.html', 'lib/acde-api/package.json']) {
      expect(listed).toContain(`${name}/${path}`)
    }
    expect(listed.some((path) => path.endsWith('.js.map') || path.includes('/._'))).toBe(false)
    const cli = (await run(['tar', '-xOzf', tarball, `${name}/lib/acde/src/cli.js`], {})).stdout
    expect(cli.slice(0, 200)).not.toMatch(/^#!|@bun/m)
    expect(listed.every((path) => !path || path.startsWith(`${name}/`))).toBe(true)
    const sum = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    expect(readFileSync(join(out, '0.0.2', 'SHA256SUMS'), 'utf8')).toBe(`${sum}  ${name}.tar.gz\n`)
    expect(readFileSync(join(out, 'latest'), 'utf8')).toBe('0.0.2\n')
    const windows = await run([process.execPath, 'scripts/dist.ts', '--acdert', join(inputs, 'acdert'), '--host', join(inputs, 'host'), '--triple', 'x86_64-pc-windows-msvc', '--version', '0.0.2', '--out', out], {})
    expect(windows.code, windows.out).toBe(0)
    const win = `acde-0.0.2-x86_64-pc-windows-msvc`
    const winListed = (await run(['tar', '-tzf', join(out, '0.0.2', `${win}.tar.gz`)], {})).stdout.split('\n')
    for (const path of ['bin/acde.cmd', 'bin/acdert.exe', 'lib/acde/src/cli.js']) expect(winListed).toContain(`${win}/${path}`)
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
    expect(readFileSync(join(home, '.config/fish/conf.d/acde.fish'), 'utf8')).toBe(`\n# acde\nfish_add_path -g "${join(home, '.acde', 'bin')}"\n`)
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

  test('bin/acde: bun if there is one, else node 22+, else a clear error; the launcher finds the acdert beside it', async () => {
    const home = tmp()
    expect((await install(home, ['--no-modify-path'])).code).toBe(0)
    const acde = join(home, '.acde', 'bin', 'acde')
    const tools = tmp()
    symlinkSync(process.execPath, join(tools, 'bun'))
    const usage = await run([acde], { PATH: `${tools}:/usr/bin:/bin` })
    expect(usage.code).toBe(1)
    expect(usage.stderr).toContain('usage: acde <command>')
    const nodes = tmp()
    writeFileSync(join(nodes, 'node'), '#!/bin/sh\nif [ "$1" = -p ]; then echo "$FAKE_NODE"; else echo "node $*"; fi\n', { mode: 0o755 })
    const picked = await run([acde, 'new', 'x'], { PATH: `${nodes}:/usr/bin:/bin`, FAKE_NODE: '24' })
    expect(picked.stdout).toBe(`node ${realpathSync(join(home, '.acde', 'versions', '0.0.2', 'lib', 'acde', 'src', 'cli.js'))} new x\n`)
    const old = await run([acde], { PATH: `${nodes}:/usr/bin:/bin`, FAKE_NODE: '20' })
    expect(old.code).toBe(1)
    expect(old.stderr).toContain('needs Node.js 22 or newer')
    const none = await run([acde], { PATH: '/usr/bin:/bin' })
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('needs Bun or Node.js 22+')
    const launcher = join(home, '.acde', 'current', 'lib', 'acde', 'launcher.mjs')
    const found = await run([process.execPath, '-e', `const m = await import(${JSON.stringify(launcher)}); console.log(await m.requireAcdert())`], { PATH: '/usr/bin:/bin', ACDE_INSTALL: join(tmp(), 'none') })
    expect(found.stdout.trim()).toBe(join(realpathSync(home), '.acde', 'versions', '0.0.2', 'bin', 'acdert'))
  }, 30_000)
})
