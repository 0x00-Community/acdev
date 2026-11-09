import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { socketDir, socketPath } from '../src/sockets.ts'
import { cleanup, env, get, inetSockets, line, tmp, WINDOWS } from './helpers.ts'

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

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})
afterAll(cleanup)

describe('listen on a port goes to <dir>/<port>.sock', () => {
  test('Bun.serve({port: 3000, hostname: "0.0.0.0"})', async () => {
    const dir = join(tmp(), 'sockets')
    const child = start('bun-serve.ts', { ACDE_APP_SOCKETS: dir })
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

describe('around the mapping', () => {
  test.skipIf(WINDOWS)('a stale Unix backend socket file is replaced', async () => {
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
