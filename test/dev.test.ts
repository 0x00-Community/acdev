import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevClient, DevServer, Lines, type Message } from '../src/ipc.ts'
import { Sessions, type Session } from '../src/sessions.ts'
import { Tools } from '../src/tools.ts'
import { cleanup, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const FAKE = join(import.meta.dir, 'fixtures/dev/fake-acdert.ts')

afterAll(cleanup)

async function until<T>(what: string, get: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = get()
    if (value) return value
    if (Date.now() - started > ms) throw new Error(`waited ${ms} ms for ${what}`)
    await Bun.sleep(20)
  }
}

class FakeRuntime {
  readonly got: Message[] = []
  readonly socket: net.Socket

  private constructor(socket: net.Socket) {
    this.socket = socket
    Lines.read(socket, (message) => this.got.push(message))
  }

  static async connect(endpoint: string, hello: Record<string, unknown>): Promise<FakeRuntime> {
    const socket = net.connect(endpoint)
    await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
    Lines.write(socket, { type: 'hello', ...hello })
    return new FakeRuntime(socket)
  }

  requests(): Message[] {
    return this.got.filter((m) => m['type'] === 'request')
  }

  reply(request: Message, answer: Record<string, unknown>): void {
    Lines.write(this.socket, { type: 'response', id: request['id'], ...answer })
  }
}

describe('dev IPC: acde dev relays tool requests to the runtime', () => {
  const servers: DevServer[] = []

  async function server(timeoutMs = 2_000): Promise<DevServer> {
    const made = new DevServer({ endpoint: join(tmp(), 'dev.sock'), timeoutMs, log: () => undefined })
    await made.listen()
    servers.push(made)
    return made
  }

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close()
  })

  test.skipIf(process.platform === 'win32')('the socket can eval in pages, so only its owner may reach it', async () => {
    const dir = join(tmp(), 'sessions')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    const made = new DevServer({ endpoint: join(dir, 'dev.sock'), log: () => undefined })
    await made.listen()
    servers.push(made)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(made.endpoint).mode & 0o777).toBe(0o600)
    expect(DevServer.endpoint(4242)).toBe(join(Sessions.dir(), '4242.sock'))
  })

  test.skipIf(process.platform === 'win32')('the session dir is per user and never followed through a symlink', () => {
    expect(Sessions.dir({ XDG_RUNTIME_DIR: '/run/user/501' })).toBe('/run/user/501/acde-dev')
    expect(Sessions.dir({ XDG_RUNTIME_DIR: 'relative' })).toBe(join(tmpdir(), `acde-dev-${process.getuid!()}`))
    expect(Sessions.dir({})).toBe(join(tmpdir(), `acde-dev-${process.getuid!()}`))
    const root = tmp()
    const victim = join(root, 'victim')
    mkdirSync(victim, { mode: 0o755 })
    const planted = join(root, 'planted')
    symlinkSync(victim, planted)
    expect(() => Sessions.prepare(planted)).toThrow('not a plain directory')
    expect(statSync(victim).mode & 0o777).toBe(0o755)
    expect(Sessions.list(planted)).toEqual([])
  })

  test('ids are rewritten so tools never collide; each answer goes to the tool that asked, with its own id', async () => {
    const s = await server()
    const runtime = await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 4242 })
    const [one, two] = await Promise.all([DevClient.connect(s.endpoint), DevClient.connect(s.endpoint)])
    const first = one.request('eval', { web: 'a', code: '1' })
    const second = two.request('eval', { web: 'b', code: '2' })
    const requests = await until('two requests', () => runtime.requests().length === 2 && runtime.requests())
    expect(new Set(requests.map((r) => r['id'])).size).toBe(2)
    expect(requests.map((r) => r['op'])).toEqual(['eval', 'eval'])
    for (const request of [...requests].reverse()) runtime.reply(request, { ok: true, result: { value: request['web'] } })
    expect(await first).toEqual({ value: 'a' })
    expect(await second).toEqual({ value: 'b' })
    expect(s.runtime).toEqual({ pid: 4242, legacy: false })
    one.close()
    two.close()
  })

  test('an error from the runtime reaches the tool as a rejected request', async () => {
    const s = await server()
    const runtime = await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 1 })
    const tool = await DevClient.connect(s.endpoint)
    const asked = tool.request('shot', { web: 'gone' })
    const [request] = await until('a request', () => runtime.requests().length === 1 && runtime.requests())
    runtime.reply(request!, { ok: false, error: 'no web "gone"' })
    expect(asked).rejects.toThrow('no web "gone"')
    tool.close()
  })

  test('a request before acdert connects waits for it', async () => {
    const s = await server()
    const tool = await DevClient.connect(s.endpoint)
    const asked = tool.request('webs')
    await Bun.sleep(50)
    const runtime = await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 2 })
    const [request] = await until('the queued request', () => runtime.requests().length === 1 && runtime.requests())
    runtime.reply(request!, { ok: true, result: { webs: [] } })
    expect(await asked).toEqual({ webs: [] })
    tool.close()
  })

  test('an acdert that never answers: "timed out" after the timeout', async () => {
    const s = await server(150)
    await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 3 })
    const tool = await DevClient.connect(s.endpoint)
    expect(tool.request('eval', { web: 'x', code: '1' })).rejects.toThrow(/^timed out: acdert did not answer "eval" within 0 s$/)
    await Bun.sleep(300)
    tool.close()
  })

  test('an acdert from before the dev tools (hello without role) is the runtime, and requests fail at once, saying why', async () => {
    const s = await server(60_000)
    const runtime = await FakeRuntime.connect(s.endpoint, { pid: 77 })
    const tool = await DevClient.connect(s.endpoint)
    const started = Date.now()
    expect(tool.request('webs')).rejects.toThrow('acdert (pid 77) is older than the dev tools')
    await Bun.sleep(20)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(runtime.requests()).toEqual([])
    expect(s.send({ type: 'reload', app: 'a' })).toBe(true)
    await until('the reload', () => runtime.got.some((m) => m['type'] === 'reload'))
    tool.close()
  })

  test('acdert going away answers what it was asked; a second runtime is refused', async () => {
    const s = await server()
    const runtime = await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 5 })
    const intruder = await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 6 })
    await until('the second runtime to be closed', () => intruder.socket.destroyed || intruder.socket.readyState === 'closed')
    const tool = await DevClient.connect(s.endpoint)
    const asked = tool.request('snapshot', {})
    await until('the request', () => runtime.requests().length === 1)
    runtime.socket.destroy()
    expect(asked).rejects.toThrow('acdert disconnected before answering "snapshot"')
    await Bun.sleep(20)
    expect(s.runtime).toBeNull()
    tool.close()
  })

  test('a peer whose first line is not hello is closed; a tool line that is not a request gets an error', async () => {
    const s = await server()
    const rude = net.connect(s.endpoint)
    await new Promise((resolve) => rude.once('connect', resolve))
    Lines.write(rude, { type: 'request', id: 1, op: 'webs' })
    await until('the rude peer to be closed', () => rude.destroyed || rude.readyState === 'closed')
    const tool = net.connect(s.endpoint)
    const got: Message[] = []
    Lines.read(tool, (m) => got.push(m))
    await new Promise((resolve) => tool.once('connect', resolve))
    Lines.write(tool, { type: 'hello', role: 'tool' })
    Lines.write(tool, { type: 'reload', id: 9 })
    Lines.write(tool, { type: 'request', id: 10 })
    await until('two answers', () => got.length === 2)
    expect(got).toEqual([
      { type: 'response', id: 9, ok: false, error: 'acde dev: "reload" is not a request' },
      { type: 'response', id: 10, ok: false, error: 'acde dev: a request needs an "op"' },
    ])
    tool.destroy()
  })

  test('long lines (a screenshot) arrive whole', async () => {
    const s = await server()
    const runtime = await FakeRuntime.connect(s.endpoint, { role: 'runtime', pid: 8 })
    const tool = await DevClient.connect(s.endpoint)
    const asked = tool.request('shot', { web: 'big' })
    const [request] = await until('the request', () => runtime.requests().length === 1 && runtime.requests())
    const png = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64')
    runtime.reply(request!, { ok: true, result: { png, width: 1024, height: 768 } })
    expect(((await asked) as { png: string }).png.length).toBe(png.length)
    tool.close()
  })
})

describe('dev sessions: $TMPDIR/acde-dev/<pid>.json', () => {
  const session = (over: Partial<Session>): Session => ({ pid: process.pid, endpoint: '/x.sock', dirs: [], apps: [], desktop: null, started: 1, ...over })

  test('write, list, remove; a file whose pid is dead is ignored and deleted', async () => {
    const dir = join(tmp(), 'acde-dev')
    const dead = Bun.spawn([process.execPath, '-e', '0'])
    await dead.exited
    Sessions.write(session({ dirs: ['/a'] }), dir)
    Sessions.write(session({ pid: dead.pid }), dir)
    writeFileSync(join(dir, '1234567.json'), '{ not json')
    expect(Sessions.list(dir).map((s) => s.pid)).toEqual([process.pid])
    expect(readdirSync(dir)).toEqual([`${process.pid}.json`])
    Sessions.remove(process.pid, dir)
    expect(Sessions.list(dir)).toEqual([])
  })

  test('pick: the session whose projects hold the cwd (the deepest), else the only one, else an error listing them', () => {
    const root = realpathSync(tmp())
    const a = session({ pid: 11, dirs: [join(root, 'a')], apps: ['alpha'] })
    const ab = session({ pid: 12, dirs: [join(root, 'a', 'b')], desktop: 'dopame' })
    const c = session({ pid: 13, dirs: [join(root, 'c')] })
    mkdirSync(join(root, 'a', 'b', 'src'), { recursive: true })
    mkdirSync(join(root, 'elsewhere'))
    expect(Sessions.pick([a, ab, c], join(root, 'a', 'b', 'src')).pid).toBe(12)
    expect(Sessions.pick([a, ab, c], join(root, 'a')).pid).toBe(11)
    expect(Sessions.pick([c], join(root, 'elsewhere')).pid).toBe(13)
    expect(Sessions.pick([a, ab, c], join(root, 'elsewhere'), 13).pid).toBe(13)
    expect(() => Sessions.pick([a, c], join(root, 'elsewhere'))).toThrow(/several[\s\S]*--session <pid>:\n  11  app alpha/)
    expect(() => Sessions.pick([a, { ...a, pid: 14 }], join(root, 'a'))).toThrow('several acde dev sessions run')
    expect(() => Sessions.pick([], root)).toThrow('no acde dev is running')
    expect(() => Sessions.pick([a], root, 99)).toThrow('no acde dev with pid 99:\n  11')
  })

  test('tools: the webs table and the default PNG name', () => {
    expect(Tools.table([{ name: 'desktop', app: null, kind: 'desktop', window: 0, title: 'Dopame' }, { name: 'vault#1048576', app: 'vault', kind: 'app', window: 1048576, title: '文库' }])).toBe(
      ['NAME           KIND     APP    WINDOW   TITLE', 'desktop        desktop  -      0        Dopame', 'vault#1048576  app      vault  1048576  文库'].join('\n'),
    )
    expect(Tools.fileFor('vault#1048576')).toBe('vault#1048576.png')
    expect(Tools.fileFor('a/b:c')).toBe('a-b-c.png')
  })
})

describe('acde dev with a stand-in acdert', () => {
  function project(dir: string, config: object, files: Record<string, string> = {}): string {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify(config))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return realpathSync(dir)
  }

  function start(args: string[], cwd: string, extra: Record<string, string> = {}) {
    const root = tmp()
    const log = join(root, 'fake.log')
    const acdert = join(root, 'acdert')
    writeFileSync(log, '')
    writeFileSync(acdert, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 })
    const vars = { TMPDIR: root, XDG_RUNTIME_DIR: root, ACDERT: acdert, FAKE_ACDERT_LOG: log, ACDE_PATH: '/inherited', ...extra }
    const child = Bun.spawn([process.execPath, CLI, 'dev', ...args], { cwd, env: env(vars), stdout: 'pipe', stderr: 'pipe' })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([o, e]) => o + e)
    const entries = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv?: string[]; path?: string; got?: Message })
    const tool = async (argv: string[], from = cwd, stdin?: string) => {
      const run = Bun.spawn([process.execPath, CLI, ...argv], { cwd: from, env: env({ TMPDIR: root, XDG_RUNTIME_DIR: root }), stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
      return { code, stdout, stderr }
    }
    return { child, output, entries, tool, root, sessions: join(root, 'acde-dev') }
  }

  test('several projects: built, one desktop (dopame), ACDE_PATH, a session file; tools reach the stand-in; a change reloads only its project', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const beta = project(join(base, 'beta'), { type: 'app', id: 'beta' })
    const dev = start([alpha, beta], base)
    try {
      const file = join(dev.sessions, `${dev.child.pid}.json`)
      await until('the session file', () => existsSync(file))
      const session = JSON.parse(readFileSync(file, 'utf8')) as Session
      expect(session).toMatchObject({ pid: dev.child.pid, dirs: [alpha, beta], apps: ['alpha', 'beta'], desktop: 'dopame' })
      expect(existsSync(session.endpoint)).toBe(true)
      const started = await until('the stand-in', () => dev.entries().find((e) => e.argv))
      expect(started.argv).toEqual(['desktop', 'dopame'])
      expect(started.path).toBe([join(alpha, '.acde'), join(beta, '.acde'), '/inherited'].join(':'))

      const webs = await dev.tool(['webs'], alpha)
      expect(webs.stdout).toContain('alpha#7  app      alpha  7       Alpha')
      expect(webs.code).toBe(0)
      const evaluated = await dev.tool(['eval', 'alpha', 'document.title'], join(alpha))
      expect(JSON.parse(evaluated.stdout)).toEqual({ web: 'alpha', code: 'document.title' })
      expect(JSON.parse((await dev.tool(['eval', 'desktop', '-'], alpha, '1 +\n1')).stdout)).toEqual({ web: 'desktop', code: '1 +\n1' })
      const failed = await dev.tool(['eval', 'nope', '1'], alpha)
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain('acde: no web "nope"')
      const shot = await dev.tool(['shot', 'alpha#7'], base)
      expect(shot.stdout.trim()).toBe(join(realpathSync(base), 'alpha#7.png'))
      expect(readFileSync(join(base, 'alpha#7.png')).subarray(1, 4).toString()).toBe('PNG')
      const named = await dev.tool(['shot', 'desktop', '-o', join(base, 'd.png')], alpha)
      expect(named.stdout.trim()).toBe(join(base, 'd.png'))
      expect((await dev.tool(['inspect', '--find', 'Save', '--window', 'w1', '--all'], alpha)).stdout).toBe('snapshot {"window":"w1","find":"Save","all":true}\n')
      expect((await dev.tool(['act', 'w1.5', 'type', 'hello world'], alpha)).stdout).toBe('type w1.5 "hello world"\n')
      expect((await dev.tool(['act', 'w1.5', 'fail'], alpha)).code).toBe(1)
      expect((await dev.tool(['webs', '--session', String(dev.child.pid)], '/')).code).toBe(0)
      expect((await dev.tool(['inspect', '--offscreen'], alpha)).code).toBe(0)
      const logged = await dev.tool(['console'], alpha)
      expect(logged.stdout).toBe('   1 log    alpha#7  alpha ready\n')
      expect((await dev.tool(['console', '--level', 'loud'], alpha)).stderr).toContain('--level loud: one of')
      expect((await dev.tool(['network', '--failed'], alpha)).stdout).toBe('')
      const screen = await dev.tool(['screen', '-o', join(base, 'all.png')], alpha)
      expect(screen.stdout.trim()).toBe(join(base, 'all.png'))
      expect(readFileSync(join(base, 'all.png')).subarray(1, 4).toString()).toBe('PNG')

      writeFileSync(join(alpha, 'index.html'), '<!doctype html><title>x</title><p>changed</p>')
      await until('a reload of alpha', () => dev.entries().some((e) => e.got?.['type'] === 'reload'))
      await Bun.sleep(400)
      const reloads = dev.entries().filter((e) => e.got?.['type'] === 'reload').map((e) => e.got)
      expect(reloads).toEqual([{ type: 'reload', app: 'alpha' }])
      expect(readFileSync(join(alpha, '.acde/web/index.html'), 'utf8')).toContain('changed')
    } finally {
      dev.child.kill('SIGTERM')
    }
    expect(await dev.child.exited).toBe(0)
    expect(readdirSync(dev.sessions)).toEqual([])
    expect(readdirSync(dev.root).filter((f) => f.endsWith('.sock'))).toEqual([])
    expect((await dev.tool(['webs'], base)).stderr).toContain('no acde dev is running')
  }, 30_000)

  test('the desktop project among them is the desktop; a change there reloads its apps and the desktop', async () => {
    const base = tmp()
    const desk = project(join(base, 'desk'), { type: 'desktop', id: 'desk', apps: [{ id: 'clock', label: 'Clock', entry: 'clock.html', backend: false }] }, { 'clock.html': '<!doctype html><p>clock</p>' })
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([alpha, desk], base)
    try {
      const started = await until('the stand-in', () => dev.entries().find((e) => e.argv))
      expect(started.argv).toEqual(['desktop', 'desk'])
      await until('the runtime hello', () => existsSync(join(dev.sessions, `${dev.child.pid}.json`)))
      await Bun.sleep(200)
      writeFileSync(join(desk, 'clock.html'), '<!doctype html><p>tick</p>')
      await until('two reloads', () => dev.entries().filter((e) => e.got?.['type'] === 'reload').length >= 2)
      await Bun.sleep(400)
      expect(dev.entries().filter((e) => e.got?.['type'] === 'reload').map((e) => e.got)).toEqual([{ type: 'reload', app: 'clock' }, { type: 'reload' }])
    } finally {
      dev.child.kill('SIGTERM')
    }
    await dev.child.exited
  }, 30_000)

  test('--desktop <dir> adds that project and runs its desktop; one project alone is unchanged (acdert app <id>)', async () => {
    const base = tmp()
    const desk = project(join(base, 'desk'), { type: 'desktop', id: 'mydesk' })
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const withDesk = start(['--desktop', desk], alpha)
    try {
      expect((await until('the stand-in', () => withDesk.entries().find((e) => e.argv))).argv).toEqual(['desktop', 'mydesk'])
      const file = join(withDesk.sessions, `${withDesk.child.pid}.json`)
      expect((await until('the session', () => existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as Session))).dirs).toEqual([alpha, desk])
    } finally {
      withDesk.child.kill('SIGTERM')
    }
    await withDesk.child.exited
    const alone = start([], alpha)
    try {
      expect((await until('the stand-in', () => alone.entries().find((e) => e.argv))).argv).toEqual(['app', 'alpha'])
    } finally {
      alone.child.kill('SIGTERM')
    }
    await alone.child.exited
  }, 30_000)

  test('an acdert from before the dev tools: tools get a clear error at once', async () => {
    const alpha = project(join(tmp(), 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { FAKE_ACDERT_LEGACY: '1' })
    try {
      await until('the session', () => existsSync(join(dev.sessions, `${dev.child.pid}.json`)))
      await until('the stand-in', () => dev.entries().find((e) => e.argv))
      const result = await dev.tool(['webs'], alpha)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('is older than the dev tools')
    } finally {
      dev.child.kill('SIGTERM')
    }
    await dev.child.exited
  }, 30_000)

  test('mistakes: --out with several projects, --app with several, the same app twice, two desktops', async () => {
    const base = tmp()
    const a = project(join(base, 'a'), { type: 'app', id: 'same' })
    const b = project(join(base, 'b'), { type: 'app', id: 'same' })
    const d1 = project(join(base, 'd1'), { type: 'desktop', id: 'd1' })
    const d2 = project(join(base, 'd2'), { type: 'desktop', id: 'd2' })
    const cases: [string[], string][] = [
      [[a, d1, '--out', join(base, 'x')], '--out is for one project'],
      [[a, d1, '--app', 'same'], '--app picks the window of one project'],
      [[a, b], `app same is in both ${a} and ${b}`],
      [[d1, d2], 'several desktops (d1, d2): pick one with --desktop <id>'],
      [[a, '--desktop', join(base, 'nowhere')], 'no project or package there'],
      [[a, '--desktop', a], 'it has no desktop'],
    ]
    for (const [args, message] of cases) {
      const dev = start(args, base)
      expect(await dev.child.exited).toBe(1)
      expect(await dev.output).toContain(message)
    }
  }, 30_000)
})
