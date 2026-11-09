import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { DevClient, Lines, type Message } from '../src/ipc.ts'
import { Sessions, type Session } from '../src/sessions.ts'
import { Format } from '../src/driver/format.ts'
import { slug } from '../src/paths.ts'
import { cleanup, env, fakeAcdert, skipping, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

afterAll(cleanup)

function testEndpoint(): string {
  return WINDOWS ? `\\\\.\\pipe\\acde-test-${randomUUID()}` : join(tmp(), 'dev.sock')
}

async function until<T>(what: string, get: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = get()
    if (value) return value
    if (Date.now() - started > ms) throw new Error(`waited ${ms} ms for ${what}`)
    await Bun.sleep(20)
  }
}

class FakeAcdert {
  readonly got: Message[] = []
  readonly server: net.Server
  readonly sockets: net.Socket[] = []
  answer: (request: Message, socket: net.Socket) => void = () => undefined

  constructor(readonly endpoint: string) {
    this.server = net.createServer((socket) => {
      this.sockets.push(socket)
      Lines.read(socket, (message) => {
        this.got.push(message)
        if (message['type'] === 'request') this.answer(message, socket)
      })
    })
  }

  listen(): Promise<this> {
    return new Promise((resolve) => this.server.listen(this.endpoint, () => resolve(this)))
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

describe('dev IPC: tools and acde dev talk to acdert directly', () => {
  const fakes: FakeAcdert[] = []

  async function acdert(answer?: FakeAcdert['answer']): Promise<FakeAcdert> {
    const fake = new FakeAcdert(testEndpoint())
    if (answer) fake.answer = answer
    fakes.push(fake)
    return fake.listen()
  }

  afterEach(async () => {
    for (const fake of fakes.splice(0)) await fake.close()
  })

  const unixOnly = (why: string) => test.skipIf(skipping(WINDOWS, why))

  unixOnly('session dir modes and socket files: Unix only')('acde dev prepares a private session dir and clears ' +
    'a stale socket before acdert listens', () => {
    const dir = join(tmp(), 'sessions')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    const endpoint = join(dir, 'dev.sock')
    writeFileSync(endpoint, '')
    DevClient.prepare(endpoint)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(existsSync(endpoint)).toBe(false)
    expect(DevClient.endpoint(4242)).toBe(join(Sessions.dir(), '4242.sock'))
  })

  unixOnly('a per-uid session dir and symlinks: Unix only')('the session dir is per user and never followed ' +
    'through a symlink', () => {
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

  test('each answer settles its own request; an error rejects it; no hello is sent', async () => {
    const fake = await acdert((request, socket) => {
      const id = request['id']
      const web = request['web']
      if (web === 'gone') return Lines.write(socket, { type: 'response', id, ok: false, error: 'no web "gone"' })
      const answer = () => Lines.write(socket, { type: 'response', id, ok: true, result: { value: web } })
      if (web === 'a') setTimeout(answer, 30)
      else answer()
    })
    const tool = await DevClient.connect(fake.endpoint, 2_000)
    const first = tool.request('eval', { web: 'a', code: '1' })
    const second = tool.request('eval', { web: 'b', code: '2' })
    expect(await second).toEqual({ value: 'b' })
    expect(await first).toEqual({ value: 'a' })
    const failure = await tool.request('shot', { web: 'gone' }).catch((error: Error) => error.message)
    expect(failure).toBe('no web "gone"')
    await until('three requests', () => fake.got.length === 3)
    expect(fake.got.map((m) => m['type'])).toEqual(['request', 'request', 'request'])
    tool.close()
  })

  test('reach: waits until acdert listens, sends nothing on its own; gives up once acdert is gone', async () => {
    const endpoint = testEndpoint()
    let warned = 0
    const reaching = DevClient.reach(endpoint, () => true, () => warned++, 50)
    await Bun.sleep(150)
    const fake = new FakeAcdert(endpoint)
    fakes.push(fake)
    await fake.listen()
    const link = await reaching
    expect(link).not.toBeNull()
    expect(warned).toBe(1)
    link!.send({ type: 'hello', role: 'dev' })
    await until('the hello', () => fake.got.length === 1)
    expect(fake.got).toEqual([{ type: 'hello', role: 'dev' }])
    link!.close()
    expect(await DevClient.reach(testEndpoint(), () => false)).toBeNull()
  })

  test('an acdert that never answers: "timed out"; one that goes away fails what is waiting', async () => {
    const fake = await acdert()
    const tool = await DevClient.connect(fake.endpoint, 100)
    const timeout = await tool.request('eval', { web: 'x', code: '1' }).catch((error: Error) => error.message)
    expect(timeout).toBe('timed out: acdert did not answer "eval" within 0 s')
    const asked = tool.request('snapshot').catch((error: Error) => error)
    await until('the request', () => fake.got.length === 2)
    for (const socket of fake.sockets) socket.destroy()
    expect(await asked).toBeInstanceOf(Error)
    await tool.closed
  })

  test('long lines (a screenshot) arrive whole', async () => {
    const png = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64')
    const fake = await acdert((request, socket) =>
      Lines.write(socket, { type: 'response', id: request['id'], ok: true, result: { png, width: 1024, height: 768 } }))
    const tool = await DevClient.connect(fake.endpoint)
    expect(((await tool.request('shot', { web: 'big' })) as { png: string }).png.length).toBe(png.length)
    tool.close()
  })
})

describe('dev sessions: $TMPDIR/acde-dev/<pid>.json', () => {
  const session = (over: Partial<Session>): Session =>
    ({ pid: process.pid, endpoint: '/x.sock', dirs: [], apps: [], desktop: null, started: 1, ...over })

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

  test('pick: the session whose projects hold the cwd (the deepest), else the only one, ' +
    'else an error listing them', () => {
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
    expect(() => Sessions.pick([a, c], join(root, 'elsewhere')))
      .toThrow(/several[\s\S]*--session <pid>:\n  11  app alpha/)
    expect(() => Sessions.pick([a, { ...a, pid: 14 }], join(root, 'a'))).toThrow('several acde dev sessions run')
    expect(() => Sessions.pick([], root)).toThrow('no acde dev is running')
    expect(() => Sessions.pick([a], root, 99)).toThrow('no acde dev with pid 99:\n  11')
  })

  test('tools: the webs table and the default PNG name', () => {
    expect(Format.webs([
      { name: 'desktop', app: null, kind: 'desktop', window: 0, title: 'Dopame' },
      { name: 'vault#1048576', app: 'vault', kind: 'app', window: 1048576, title: '文库' },
    ])).toBe([
      'NAME           KIND     APP    WINDOW   TITLE',
      'desktop        desktop  -      0        Dopame',
      'vault#1048576  app      vault  1048576  文库',
    ].join('\n'))
    expect(slug('vault#1048576')).toBe('vault#1048576')
    expect(slug('a/b:c')).toBe('a-b-c')
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
    const acdert = fakeAcdert(root)
    writeFileSync(log, '')
    const vars = {
      TMPDIR: root, XDG_RUNTIME_DIR: root, ACDERT: acdert, FAKE_ACDERT_LOG: log, ACDE_PATH: '/inherited', ...extra,
    }
    const child = Bun.spawn([process.execPath, CLI, 'dev', ...args], {
      cwd, env: env(vars), stdout: 'pipe', stderr: 'pipe',
    })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(([o, e]) => o + e)
    const entries = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv?: string[]; path?: string; got?: Message })
    const tool = async (argv: string[], from = cwd, stdin?: string) => {
      const run = Bun.spawn([process.execPath, CLI, ...argv], {
        cwd: from,
        env: env({ TMPDIR: root, XDG_RUNTIME_DIR: root }),
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        run.exited, new Response(run.stdout).text(), new Response(run.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const sessions = join(root, 'acde-dev')
    const file = join(sessions, `${child.pid}.json`)
    const stop = async () => {
      if (!WINDOWS || !existsSync(file)) child.kill('SIGTERM')
      else {
        const session = JSON.parse(readFileSync(file, 'utf8')) as Session
        const link = await DevClient.connect(session.endpoint)
        link.send({ type: 'quit' })
        link.close()
      }
      return child.exited
    }
    return { child, output, entries, tool, root, sessions, file, stop }
  }

  test('several projects: built, one desktop (dopame), ACDE_PATH, a session file; tools reach the stand-in; ' +
    'a change reloads only its project', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const beta = project(join(base, 'beta'), { type: 'app', id: 'beta' })
    const dev = start([alpha, beta], base, { FAKE_ACDERT_LISTEN_MS: '300' })
    try {
      const file = join(dev.sessions, `${dev.child.pid}.json`)
      await until('the session file', () => existsSync(file))
      const session = JSON.parse(readFileSync(file, 'utf8')) as Session
      expect(session)
        .toMatchObject({ pid: dev.child.pid, dirs: [alpha, beta], apps: ['alpha', 'beta'], desktop: 'dopame' })
      if (WINDOWS) expect(session.endpoint).toBe(`\\\\.\\pipe\\acde-dev-${dev.child.pid}`)
      else expect(statSync(session.endpoint).mode & 0o777).toBe(0o600)
      expect(dev.entries().find((e) => e.got)?.got).toEqual({ type: 'hello', role: 'dev' })
      const started = await until('the stand-in', () => dev.entries().find((e) => e.argv))
      expect(started.argv).toEqual(['desktop', 'dopame'])
      expect(started.path).toBe([join(alpha, '.acde'), join(beta, '.acde'), '/inherited'].join(delimiter))

      const webs = await dev.tool(['webs'], alpha)
      expect(webs.stdout).toContain('alpha#7  app      alpha  7       Alpha')
      expect(webs.code).toBe(0)
      const evaluated = await dev.tool(['eval', 'alpha', 'document.title'], join(alpha))
      expect(JSON.parse(evaluated.stdout)).toEqual({ web: 'alpha', code: 'document.title' })
      const piped = await dev.tool(['eval', 'desktop', '-'], alpha, '1 +\n1')
      expect(JSON.parse(piped.stdout)).toEqual({ web: 'desktop', code: '1 +\n1' })
      const failed = await dev.tool(['eval', 'nope', '1'], alpha)
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain('acde: no web "nope"')
      const shot = await dev.tool(['shot', 'alpha#7'], base)
      expect(shot.stdout.trim()).toBe(join(realpathSync(base), 'alpha#7.png'))
      expect(readFileSync(join(base, 'alpha#7.png')).subarray(1, 4).toString()).toBe('PNG')
      const named = await dev.tool(['shot', 'desktop', '-o', join(base, 'd.png')], alpha)
      expect(named.stdout.trim()).toBe(join(base, 'd.png'))
      const inspected = await dev.tool(['inspect', '--find', 'Save', '--window', 'w1', '--all'], alpha)
      expect(inspected.stdout).toBe('snapshot {"window":"w1","find":"Save","all":true}\n')
      expect((await dev.tool(['act', 'w1.5', 'type', 'hello world'], alpha)).stdout).toBe('type w1.5 "hello world"\n')
      expect((await dev.tool(['act', 'w1.5', 'fail'], alpha)).code).toBe(1)
      expect((await dev.tool(['webs', '--session', String(dev.child.pid)], dev.root)).code).toBe(0)
      expect((await dev.tool(['inspect', '--offscreen'], alpha)).code).toBe(0)
      const logged = await dev.tool(['console'], alpha)
      expect(logged.stdout).toBe('   1 log    alpha#7  alpha ready\n')
      expect((await dev.tool(['console', '--level', 'loud'], alpha)).stderr).toContain('--level loud: one of')
      expect((await dev.tool(['network', '--failed'], alpha)).stdout).toBe('')
      const screen = await dev.tool(['screen', '-o', join(base, 'all.png')], alpha)
      expect(screen.stdout.trim()).toBe(join(base, 'all.png'))
      expect(readFileSync(join(base, 'all.png')).subarray(1, 4).toString()).toBe('PNG')

      mkdirSync(join(alpha, 'e2e/__screenshots__/a.e2e.ts'), { recursive: true })
      writeFileSync(join(alpha, 'e2e/__screenshots__/a.e2e.ts/look-darwin.png'), 'baseline')
      writeFileSync(join(alpha, 'e2e/a.e2e.ts'), 'export {}')
      mkdirSync(join(alpha, 'nested/node_modules'), { recursive: true })
      writeFileSync(join(alpha, 'nested/node_modules/x.js'), '')
      await Bun.sleep(600)
      expect(dev.entries().filter((e) => e.got?.['type'] === 'reload')).toEqual([])
      writeFileSync(join(alpha, 'index.html'), '<!doctype html><title>x</title><p>changed</p>')
      await until('a reload of alpha', () => dev.entries().some((e) => e.got?.['type'] === 'reload'))
      await Bun.sleep(400)
      const reloads = dev.entries().filter((e) => e.got?.['type'] === 'reload').map((e) => e.got)
      expect(reloads).toEqual([{ type: 'reload', app: 'alpha' }])
      expect(readFileSync(join(alpha, '.acde/web/index.html'), 'utf8')).toContain('changed')
    } finally {
      await dev.stop()
    }
    expect(await dev.child.exited).toBe(0)
    expect(readdirSync(dev.sessions)).toEqual([])
    expect(readdirSync(dev.root).filter((f) => f.endsWith('.sock'))).toEqual([])
    expect((await dev.tool(['webs'], base)).stderr).toContain('no acde dev is running')
  }, 120_000)

  test('the desktop project among them is the desktop; a change there reloads its apps and the desktop', async () => {
    const base = tmp()
    const desk = project(
      join(base, 'desk'),
      { type: 'desktop', id: 'desk', apps: [{ id: 'clock', label: 'Clock', entry: 'clock.html', backend: false }] },
      { 'clock.html': '<!doctype html><p>clock</p>' },
    )
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
      expect(dev.entries().filter((e) => e.got?.['type'] === 'reload').map((e) => e.got))
        .toEqual([{ type: 'reload', app: 'clock' }, { type: 'reload' }])
    } finally {
      await dev.stop()
    }
    await dev.child.exited
    expect(readdirSync(dev.sessions)).toEqual([])
  }, 30_000)

  test('acde dev killed from outside: acdert follows; the next tool drops the session file it left', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([alpha], base)
    await until('the session file', () => existsSync(dev.file))
    const session = JSON.parse(readFileSync(dev.file, 'utf8')) as Session
    dev.child.kill('SIGKILL')
    await dev.child.exited
    expect(readdirSync(dev.sessions).filter((f) => f.endsWith('.json'))).toEqual([`${dev.child.pid}.json`])
    const gone = async () => {
      for (const started = Date.now(); Date.now() - started < 10_000; await Bun.sleep(50)) {
        const link = await DevClient.connect(session.endpoint, 200).catch(() => null)
        if (!link) return true
        link.close()
      }
      return false
    }
    expect(await gone()).toBe(true)
    const webs = await dev.tool(['webs'], alpha)
    expect(webs.code).toBe(1)
    expect(webs.stderr).toContain('no acde dev is running')
    expect(readdirSync(dev.sessions).filter((f) => f.endsWith('.json'))).toEqual([])

    Sessions.write({ ...session, pid: process.pid }, dev.sessions)
    const reused = await dev.tool(['webs'], alpha)
    expect(reused.code).toBe(1)
    expect(reused.stderr).toContain(`acde dev ${process.pid} is gone`)
    expect(readdirSync(dev.sessions).filter((f) => f.endsWith('.json'))).toEqual([])
  }, 30_000)

  test('--desktop <dir> adds that project and runs its desktop; ' +
    'one project alone is unchanged (acdert app <id>)', async () => {
    const base = tmp()
    const desk = project(join(base, 'desk'), { type: 'desktop', id: 'mydesk' })
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const withDesk = start(['--desktop', desk], alpha)
    try {
      const started = await until('the stand-in', () => withDesk.entries().find((e) => e.argv))
      expect(started.argv).toEqual(['desktop', 'mydesk'])
      const file = join(withDesk.sessions, `${withDesk.child.pid}.json`)
      const session = await until('the session', () =>
        existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as Session))
      expect(session.dirs).toEqual([alpha, desk])
    } finally {
      await withDesk.stop()
    }
    await withDesk.child.exited
    const alone = start([], alpha)
    try {
      expect((await until('the stand-in', () => alone.entries().find((e) => e.argv))).argv).toEqual(['app', 'alpha'])
      await until('the session file', () => existsSync(alone.file))
    } finally {
      await alone.stop()
    }
    await alone.child.exited
  }, 30_000)

  test('a runtime of another contract level: acde dev stops before starting it', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    for (const [level, runtime] of [[String(API_LEVEL + 1), API_LEVEL + 1], ['none', 0]] as const) {
      const dev = start([], alpha, { FAKE_ACDERT_LEVEL: level })
      expect(await dev.child.exited).toBe(1)
      expect(await dev.output).toContain(`alpha: needs level ${API_LEVEL}, runtime is level ${runtime}`)
      expect(dev.entries().filter((e) => e.argv)).toEqual([])
    }
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
