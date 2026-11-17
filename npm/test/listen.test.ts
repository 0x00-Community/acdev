import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import type { Subprocess } from 'bun'
import { encode, SHUTDOWN } from '../src/channel.ts'
import { socketDir, socketPath, WINDOWS_PATH_MAX } from '../src/sockets.ts'
import { cleanup, env, get, inetSockets, line, skipping, tmp, WINDOWS } from './helpers.ts'

const LISTEN = join(import.meta.dir, '../src/listen.ts')
const FIXTURES = join(import.meta.dir, 'fixtures/listen')
const children: Subprocess[] = []

function start(fixture: string, extra: Record<string, string>): Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn([process.execPath, '--preload', LISTEN, join(FIXTURES, fixture)], {
    env: env(extra),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(child)
  return child
}

function noInet(pid: number): void {
  const inet = inetSockets(pid)
  if (inet === null) console.warn(`cannot list the sockets of ${pid} (no lsof, no /proc): AF_INET check skipped`)
  else expect(inet).toEqual([])
}

const controlled: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  for (const child of controlled.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
})
afterAll(cleanup)

describe('listen on a port goes to <dir>/<port>.sock', () => {
  test('Bun.serve({port: 3000, hostname: "0.0.0.0"})', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('bun-serve.ts', { ACDE_APP_SOCKETS: dir })
    expect(await line(child, 'acdev: port 3000')).toContain('is served through acde, not over TCP')
    expect(await line(child, 'ready')).toBe('ready 3000 http://localhost:3000/')
    expect(await get(join(dir, '3000.sock'))).toBe('bun-serve /p')
    if (!WINDOWS) expect(statSync(dir).mode & 0o777).toBe(0o700)
    noInet(child.pid)
  })

  test('Bun.serve({port: process.env.PORT})', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('env-port.ts', { ACDE_APP_SOCKETS: dir, PORT: '3456' })
    expect(await line(child, 'ready')).toBe('ready 3456')
    expect(await get(join(dir, '3456.sock'))).toBe('env-port')
    noInet(child.pid)
  })

  test('export default {fetch}, no port: $PORT', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('default-export.ts', { ACDE_APP_SOCKETS: dir, PORT: '3457' })
    await line(child, 'ready')
    for (let i = 0; i < 100 && !existsSync(join(dir, '3457.sock')); i++) await Bun.sleep(20)
    expect(await get(join(dir, '3457.sock'))).toBe('default-export')
    noInet(child.pid)
  })

  test('node:http createServer().listen(3000, "127.0.0.1", cb), address() keeps the port', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('node-http.ts', { ACDE_APP_SOCKETS: dir })
    expect(await line(child, 'ready')).toBe('ready 3000')
    expect(await get(join(dir, '3000.sock'), '/api/x?y=1')).toBe('node-http /api/x?y=1')
    noInet(child.pid)
  })

  test('listen({port: 0, host: "::"})', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('listen-zero.ts', { ACDE_APP_SOCKETS: dir })
    await line(child, 'ready')
    expect(await get(join(dir, '0.sock'))).toBe('listen-zero')
    noInet(child.pid)
  })

  test('node:net createServer().listen(4000, backlog, cb)', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('net-server.ts', { ACDE_APP_SOCKETS: dir })
    await line(child, 'ready')
    expect(await get(join(dir, '4000.sock'))).toBe('net-server')
    noInet(child.pid)
  })

  test('the directory from XDG_RUNTIME_DIR and ACDE_APP_ID', async () => {
    const runtime = tmp()
    const child = start('bun-serve.ts', { XDG_RUNTIME_DIR: runtime, ACDE_APP_ID: 'demo' })
    await line(child, 'ready')
    expect(await get(join(runtime, 'acde/apps/demo/3000.sock'))).toBe('bun-serve /p')
    if (!WINDOWS) expect(statSync(join(runtime, 'acde/apps/demo')).mode & 0o777).toBe(0o700)
    noInet(child.pid)
  })
})

describe('Bun in the Windows socket mode: ACDE_APP_SOCKETS with ACDE_APP_CONTROL=fd', () => {
  const windowsEnv = (dir: string) => ({ ACDE_APP_SOCKETS: dir, ACDE_APP_CONTROL: 'fd', ACDE_APP_CHANNEL: 'fd' })

  test('Bun.serve binds <dir>/<port>.sock unmodified, even if ACDE_APP_CHANNEL is set', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('bun-serve.ts', windowsEnv(dir))
    expect(await line(child, 'ready')).toBe('ready 3000 http://localhost:3000/')
    expect(await get(join(dir, '3000.sock'))).toBe('bun-serve /p')
    noInet(child.pid)
  })

  test('node:http under bun binds in the directory too', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('node-http.ts', windowsEnv(dir))
    expect(await line(child, 'ready')).toBe('ready 3000')
    expect(await get(join(dir, '3000.sock'), '/q')).toBe('node-http /q')
  })

  const notWindows = skipping(!WINDOWS, 'the socket directory ACL: Windows only')
  test.skipIf(notWindows)('the preload leaves the ACL of the socket directory alone', async () => {
    const dir = join(tmp(), 'sockets')
    mkdirSync(dir)
    const acl = () => Bun.spawnSync(['icacls', dir]).stdout.toString()
    const mine = `${process.env['USERNAME']}:(OI)(CI)F`
    expect(Bun.spawnSync(['icacls', dir, '/inheritance:r', '/grant:r', mine]).exitCode).toBe(0)
    const before = acl()
    const child = start('bun-serve.ts', windowsEnv(dir))
    await line(child, 'ready')
    expect(await get(join(dir, '3000.sock'))).toBe('bun-serve /p')
    expect(acl()).toBe(before)
  })

  test('Windows socket paths', () => {
    expect(socketPath(3000, { ACDE_APP_SOCKETS: 'C:\\R\\a1b2' }, 'win32')).toBe('C:\\R\\a1b2\\3000.sock')
    expect(socketPath(3000, { XDG_RUNTIME_DIR: 'C:\\R', ACDE_APP_ID: 'notes' }, 'win32'))
      .toBe('C:\\R\\acde\\apps\\notes\\3000.sock')
    expect(() => socketDir({ ACDE_APP_ID: 'notes' }, 'win32')).toThrow('on Windows the runtime names the directory')
    const fits = `C:\\${'d'.repeat(WINDOWS_PATH_MAX - 'C:\\\\65535.sock'.length)}`
    expect(socketPath(65535, { ACDE_APP_SOCKETS: fits }, 'win32')).toHaveLength(WINDOWS_PATH_MAX)
    expect(() => socketPath(65535, { ACDE_APP_SOCKETS: `${fits}d` }, 'win32')).toThrow('Windows allows 107')
    expect(socketPath(65535, { ACDE_APP_SOCKETS: `/${'d'.repeat(200)}` }, 'linux')).toHaveLength(212)
    expect(socketPath(3000, { ACDE_APP_ID: 'notes' }, 'linux'))
      .toBe(`/run/user/${process.getuid?.() ?? 0}/acde/apps/notes/3000.sock`)
  })
})

describe('Bun in the Windows socket mode: SHUTDOWN on the control channel (fd 3)', () => {
  function startControlled(dir: string) {
    const child = spawn(process.execPath, ['--preload', LISTEN, join(FIXTURES, 'bun-shutdown.ts')], {
      env: env({ ACDE_APP_SOCKETS: dir, ACDE_APP_CONTROL: 'fd' }),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })
    controlled.push(child)
    let out = ''
    let err = ''
    const wakers: (() => void)[] = []
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      for (const wake of wakers.splice(0)) wake()
    })
    child.stderr!.on('data', (chunk: Buffer) => void (err += chunk.toString()))
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => {
        resolve(code)
        for (const wake of wakers.splice(0)) wake()
      }),
    )
    const printed = async (text: string) => {
      while (!out.split('\n').some((l) => l.trim() === text)) {
        if (child.exitCode !== null) throw new Error(`exited before "${text}": ${out} ${err}`)
        await new Promise<void>((resolve) => wakers.push(resolve))
      }
    }
    const shutdown = () => (child.stdio[3] as Writable).write(encode(SHUTDOWN, 0))
    return { exited, printed, shutdown }
  }

  test('the request in flight completes, every server stops, the process exits 0', async () => {
    const dir = join(tmp(), 'sockets')
    const backend = startControlled(dir)
    await backend.printed('ready')
    expect(await get(join(dir, '3001.sock'))).toBe('node')
    const slow = get(join(dir, '3000.sock'), '/slow')
    await backend.printed('slow started')
    backend.shutdown()
    expect(await slow).toBe('slow done')
    await backend.printed('node closed')
    expect(await backend.exited).toBe(0)
  }, 30_000)

  test('the control channel does not keep the process alive once the app stops its servers', async () => {
    const dir = join(tmp(), 'sockets')
    const backend = startControlled(dir)
    await backend.printed('ready')
    expect(await get(join(dir, '3000.sock'), '/stop')).toBe('stopping')
    expect(await backend.exited).toBe(0)
  }, 30_000)
})

describe('around the mapping', () => {
  const noSocketFile = skipping(WINDOWS, 'stale Unix socket files: Windows has no socket file to replace')
  test.skipIf(noSocketFile)('a stale Unix backend socket file is replaced', async () => {
    const dir = join(tmp(), 'sockets')
    const first = start('bun-serve.ts', { ACDE_APP_SOCKETS: dir })
    await line(first, 'ready')
    first.kill('SIGKILL')
    await first.exited
    expect(existsSync(join(dir, '3000.sock'))).toBe(true)
    const second = start('bun-serve.ts', { ACDE_APP_SOCKETS: dir })
    await line(second, 'ready')
    expect(await get(join(dir, '3000.sock'))).toBe('bun-serve /p')
  })

  test('listens that name a socket are left alone', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('own-socket.ts', { ACDE_APP_SOCKETS: dir })
    await line(child, 'ready')
    expect(await get(join(dir, 'own-bun.sock'))).toBe('own-bun')
    expect(await get(join(dir, 'own-node.sock'))).toBe('own-node')
    noInet(child.pid)
  })

  test('a UDP bind to a port is refused', async () => {
    const child = start('udp.ts', { ACDE_APP_SOCKETS: join(tmp(), 'sockets') })
    expect(await line(child, 'refused')).toContain('unix sockets only')
  })

  test('without ACDE_APP_SOCKETS or ACDE_APP_ID the listen throws, nothing is bound', async () => {
    const child = start('bun-serve.ts', {})
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain('no ACDE_APP_SOCKETS or ACDE_APP_ID')
  })

  test('socketDir / socketPath', () => {
    const runtime = tmp()
    const explicit = join(runtime, 'sockets')
    expect(socketDir({ ACDE_APP_SOCKETS: explicit })).toBe(explicit)
    expect(socketPath(3000, { XDG_RUNTIME_DIR: runtime, ACDE_APP_ID: 'notes' }))
      .toBe(join(runtime, 'acde', 'apps', 'notes', '3000.sock'))
    if (!WINDOWS) expect(socketDir({ ACDE_APP_ID: 'notes' })).toBe(`/run/user/${process.getuid!()}/acde/apps/notes`)
    expect(() => socketDir({ ACDE_APP_ID: '../x' })).toThrow()
  })
})
