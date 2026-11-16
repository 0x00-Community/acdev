import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { DevSession } from '../src/dev.ts'
import { Devtools } from '../src/devtools.ts'
import { DevClient, Lines, type Message } from '../src/ipc.ts'
import { Claims, Sessions, type Session } from '../src/sessions.ts'
import { Format } from '../src/driver/format.ts'
import { slug } from '../src/paths.ts'
import { cleanup, env, fakeAcdert, fakeBrowser, line, skipping, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const LAUNCHER = join(import.meta.dir, '../bin/acde.mjs')

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
    expect(timeout).toBe('timed out: acdebin-dbg did not answer "eval" within 0 s')
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
    const said: string[] = []
    expect(Sessions.pick([c], join(root, 'elsewhere'), undefined, (line) => said.push(line)).pid).toBe(13)
    expect(said).toEqual([expect.stringMatching(/^acde: using acde dev 13 \(.+\), the only one running$/)])
    expect(Sessions.pick([a, ab, c], join(root, 'a'), undefined, (line) => said.push(line)).pid).toBe(11)
    expect(said).toHaveLength(1)
    expect(Sessions.pick([a, ab, c], join(root, 'elsewhere'), 13).pid).toBe(13)
    expect(() => Sessions.pick([a, c], join(root, 'elsewhere')))
      .toThrow(/^none of the 2 acde dev sessions runs .*elsewhere; pick one with --session <pid>:\n  11  app alpha/)
    expect(() => Sessions.pick([a, { ...a, pid: 14 }], join(root, 'a'))).toThrow('several acde dev sessions run')
    expect(() => Sessions.pick([], root)).toThrow('no acde dev is running')
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other', 'acde.config.jsonc'), '{}')
    const other = `no acde dev runs the project in ${join(root, 'other')}; `
      + 'to use another one, pass --session <pid>:\n  13'
    expect(() => Sessions.pick([c], join(root, 'other'))).toThrow(other)
    expect(Sessions.pick([c], join(root, 'other'), 13).pid).toBe(13)
    expect(() => Sessions.pick([a], root, 99)).toThrow('no acde dev with pid 99:\n  11')
  })

  test('claims: one holder per project, even one whose event loop is blocked; a dead or reused holder is taken '
    + 'over; a refused claim keeps nothing; release removes only its own', async () => {
    const dir = join(tmp(), 'acde-dev')
    const project = realpathSync(tmp())
    const other = realpathSync(tmp())
    const script = join(tmp(), 'hold.ts')
    writeFileSync(script, `import { Claims } from ${JSON.stringify(join(import.meta.dir, '../src/sessions.ts'))}
const held = await Claims.take([process.argv[2]], Date.now(), process.argv[3])
console.log(held instanceof Claims ? 'held' : 'refused')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000)
`)
    const holder = Bun.spawn([process.execPath, script, project, dir], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    try {
      expect(await line(holder, 'held')).toBe('held')
      expect(await Claims.take([other, project], Date.now(), dir)).toEqual({ pid: holder.pid, dir: project })
      expect(existsSync(Claims.file(other, dir))).toBe(false)
      expect(readdirSync(dir).filter((name) => name.startsWith(`${process.pid}.`))).toEqual([])
    } finally {
      holder.kill('SIGKILL')
      await holder.exited
    }
    const mine = await Claims.take([project, other, project], Date.now(), dir)
    expect(mine).toBeInstanceOf(Claims)
    const claim = JSON.parse(readFileSync(Claims.file(project, dir), 'utf8')) as { pid: number; dir: string }
    expect([claim.pid, claim.dir]).toEqual([process.pid, project])
    expect(await Claims.take([project], Date.now(), dir)).toEqual({ pid: process.pid, dir: project })
    writeFileSync(Claims.file(other, dir), 'someone else\n')
    ;(mine as Claims).release()
    expect(readFileSync(Claims.file(other, dir), 'utf8')).toBe('someone else\n')
    expect(existsSync(Claims.file(project, dir))).toBe(false)
    const reused = { pid: process.ppid, dir: project, beacon: testEndpoint() }
    writeFileSync(Claims.file(project, dir), JSON.stringify(reused))
    const again = await Claims.take([project, other], Date.now(), dir)
    expect(again).toBeInstanceOf(Claims)
    ;(again as Claims).release()
    Sessions.list(dir)
    expect(readdirSync(dir)).toEqual([])
  }, 30_000)

  test('live: a session whose endpoint nobody answers is dropped, though its pid lives (reused)', async () => {
    const dir = join(tmp(), 'acde-dev')
    const acdert = await new FakeAcdert(testEndpoint()).listen()
    try {
      const answering = session({ pid: process.pid, endpoint: acdert.endpoint, dirs: ['/a'], started: 1 })
      const reused = session({ pid: process.ppid, endpoint: testEndpoint(), dirs: ['/a'], started: 2 })
      Sessions.write(answering, dir)
      Sessions.write(reused, dir)
      expect(Sessions.list(dir).map((s) => s.pid)).toEqual([process.pid, process.ppid])
      expect((await Sessions.live(Sessions.list(dir), dir)).map((s) => s.pid)).toEqual([process.pid])
      expect(Sessions.list(dir).map((s) => s.pid)).toEqual([process.pid])
      expect(await Sessions.answers(acdert.endpoint)).toBe(true)
    } finally {
      await acdert.close()
    }
    expect(await Sessions.answers(testEndpoint())).toBe(false)
  })

  test('runs: a session matches what was asked only with the same projects, desktop, app and headless', () => {
    const root = realpathSync(tmp())
    const app = join(root, 'app')
    const desk = join(root, 'desk')
    for (const dir of [app, desk, join(root, 'id-only')]) mkdirSync(dir)
    writeFileSync(join(desk, 'acde.config.jsonc'), '{}')
    const plain = session({ dirs: [app], options: { desktop: null, app: null } })
    expect(Sessions.runs(plain, Sessions.wanted(app, {}))).toBe(true)
    expect(Sessions.runs(plain, Sessions.wanted(root, { dirs: ['app'] }))).toBe(true)
    expect(Sessions.runs(plain, Sessions.wanted(app, { headless: true }))).toBe(false)
    expect(Sessions.runs(plain, Sessions.wanted(app, { app: 'alpha' }))).toBe(false)
    expect(Sessions.runs(plain, Sessions.wanted(root, { dirs: ['app', 'desk'] }))).toBe(false)
    expect(Sessions.runs({ ...plain, options: undefined }, Sessions.wanted(app, {}))).toBe(false)
    const desktop = session({ dirs: [app, desk], desktop: 'desk', headless: true, options: { desktop: desk, app: null } })
    expect(Sessions.runs(desktop, Sessions.wanted(root, { dirs: ['app'], desktop: 'desk', headless: true }))).toBe(true)
    expect(Sessions.runs(desktop, Sessions.wanted(root, { dirs: ['app', 'desk'], desktop: './desk', headless: true })))
      .toBe(true)
    expect(Sessions.runs(desktop, Sessions.wanted(root, { dirs: ['app'], headless: true }))).toBe(false)
    const named = session({ dirs: [app], desktop: 'id-only', options: { desktop: 'id-only', app: null } })
    expect(Sessions.wanted(app, { desktop: 'id-only' }).desktop).toBe('id-only')
    expect(Sessions.runs(named, Sessions.wanted(app, { desktop: 'id-only' }))).toBe(true)
    expect(Sessions.runs(named, Sessions.wanted(app, { desktop: 'dopame' }))).toBe(false)
    const dir = join(tmp(), 'acde-dev')
    Sessions.write({ ...desktop, pid: process.pid }, dir)
    expect(Sessions.list(dir)[0]!.options).toEqual({ desktop: desk, app: null })
  })

  test('sessions of acde test: pick and running pass them by; --session still reaches them', () => {
    const root = realpathSync(tmp())
    const a = session({ pid: 11, dirs: [join(root, 'a')], apps: ['alpha'] })
    const tested = session({ pid: 12, dirs: [join(root, 'a')], apps: ['alpha'], headless: true, test: true })
    const elsewhere = session({ pid: 13, dirs: [join(root, 'b')], apps: ['beta'], test: true })
    mkdirSync(join(root, 'a', 'src'), { recursive: true })
    mkdirSync(join(root, 'elsewhere'))
    expect(Sessions.pick([tested, a], join(root, 'a', 'src')).pid).toBe(11)
    expect(Sessions.pick([tested, a], join(root, 'a'), 12).pid).toBe(12)
    const said: string[] = []
    expect(Sessions.pick([elsewhere, a], join(root, 'elsewhere'), undefined, (line) => said.push(line)).pid).toBe(11)
    expect(said).toEqual([expect.stringMatching(/^acde: using acde dev 11 \(app alpha\), the only one running$/)])
    expect(() => Sessions.pick([tested], join(root, 'a')))
      .toThrow(/^no acde dev is running, only sessions of acde test, which are reached only with --session <pid>:\n {2}12 {2}app alpha \(headless, acde test\)/)
    expect(Sessions.running([tested, elsewhere], [join(root, 'a'), join(root, 'b')])).toEqual([])
    expect(Sessions.running([tested, a], [join(root, 'a')]).map((s) => s.pid)).toEqual([11])
    const dir = join(tmp(), 'acde-dev')
    Sessions.write({ ...tested, pid: process.pid, started: 1 }, dir)
    Sessions.write({ ...a, pid: process.ppid, started: 2 }, dir)
    expect(Sessions.list(dir).map((s) => [s.pid, s.test === true])).toEqual([[process.pid, true], [process.ppid, false]])
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

  test('query prints an element as inspect does, a heading with its level, then the tag', () => {
    const heading = { ref: 'w1.16', role: 'heading', name: 'Notes', level: 1, tag: 'h1', visible: true }
    const field = { ref: 'w1.18', role: 'textbox', name: 'Title', value: '', states: ['focused'], tag: 'input', visible: true }
    const ghost = { ref: 'w1.30', role: 'heading', name: 'Later', level: 2, states: ['transparent'], tag: 'h2', visible: false }
    expect(Format.node(heading)).toBe('heading "Notes" [level=1] [w1.16]')
    expect(Format.matches({ window: 'w1', count: 3, nodes: [heading, field, ghost] }, 'h1, input, h2')).toBe([
      '3 in w1:',
      '- heading "Notes" [level=1] [w1.16] <h1>',
      '- textbox "Title": "" [focused] [w1.18] <input>',
      '- heading "Later" [level=2] [transparent] [w1.30] <h2> [hidden]',
    ].join('\n'))
  })

  test('inspect --find: only the matching elements, each with its nearest named ancestor', () => {
    const window = { id: 7, kind: 'web', app: 'todo', title: 'To-do', mode: 'normal', rect: [0, 0, 8, 6] } as const
    const windows = [{ ...window, ref: 'w1', z: 1, focus: true, hidden: false, pid: null }]
    const item = {
      ref: 'w1.10', role: 'listitem', name: 'Buy milk',
      children: [
        { ref: 'w1.11', role: 'text', name: 'Buy milk' },
        { ref: 'w1.12', role: 'checkbox', name: 'Done', states: ['checked'] },
        { ref: 'w1.13', role: 'button', name: 'Delete' },
      ],
    }
    const trees = { w1: [{ ref: 'w1.4', role: 'list', children: [item] }] }
    expect(Format.found({ text: '', windows, trees }, ' MILK ')).toEqual([
      'w1 todo "To-do":',
      '- listitem "Buy milk" [w1.10]',
      '- text "Buy milk" [w1.11]  in listitem "Buy milk" [w1.10]',
    ])
    expect(Format.found({ text: '', windows, trees }, 'delete'))
      .toEqual(['w1 todo "To-do":', '- button "Delete" [w1.13]  in listitem "Buy milk" [w1.10]'])
    expect(Format.found({ text: '', windows, trees }, 'nothing')).toEqual([])
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

  function start(args: string[], cwd: string, extra: Record<string, string> = {}, root = tmp()) {
    const log = join(root, existsSync(join(root, 'fake.log')) ? `fake-${randomUUID()}.log` : 'fake.log')
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
    const tool = async (argv: string[], from = cwd, stdin?: string, more: Record<string, string> = {}) => {
      const run = Bun.spawn([process.execPath, CLI, ...argv], {
        cwd: from,
        env: env({ TMPDIR: root, XDG_RUNTIME_DIR: root, ...more }),
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
      const frontend = (id: number) => new RegExp('^devtools://devtools/bundled/devtools_app\\.html\\?ws='
        + `127\\.0\\.0\\.1%3A\\d+%2Fdevtools%2Fpage%2F${id}%3Ftoken%3Dfake-token\\n$`)
      const noBrowser = { ACDE_BROWSER: 'none' }
      const focused = await dev.tool(['devtools'], alpha, undefined, noBrowser)
      expect(focused.code, focused.stderr).toBe(0)
      expect(focused.stdout).toMatch(frontend(7))
      expect(focused.stderr).toContain('acde: DevTools for Alpha: ACDE_BROWSER=none: no browser opened; paste')
      const desk = await dev.tool(['devtools', 'desktop'], alpha, undefined, noBrowser)
      expect(desk.code, desk.stderr).toBe(0)
      expect(desk.stdout).toMatch(frontend(0))
      expect((await dev.tool(['devtools', 'alpha'], alpha, undefined, noBrowser)).stdout).toMatch(frontend(7))
      const nowhere = await dev.tool(['devtools', 'nope'], alpha, undefined, noBrowser)
      expect(nowhere.code).toBe(1)
      expect(nowhere.stderr).toContain('acde: no DevTools target for nope; the targets are:\n  0  page  Desk\n')
      const listed = (e: object) => (e as { devtools?: string }).devtools === '/json/list?token=fake-token'
      expect(dev.entries().some(listed)).toBe(true)
      const launched: string[] = []
      const chromium = join('/opt/bin', 'chromium')
      const opened = await Devtools.run({
        window: 'alpha',
        cwd: alpha,
        env: { TMPDIR: dev.root, XDG_RUNTIME_DIR: dev.root },
        say: () => undefined,
        lookup: { platform: 'linux', env: { PATH: '/opt/bin' }, home: '/home/me', exists: (path) => path === chromium },
        launch: (browser, url) => launched.push(`${browser.path} ${url}`),
      })
      expect(opened).toBe(0)
      expect(launched).toHaveLength(1)
      expect(launched[0]!.startsWith(`${chromium} devtools://devtools/bundled/devtools_app.html?ws=`)).toBe(true)
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
      const inspected = await dev.tool(['inspect', '--find', 'add', '--window', 'w1', '--all'], alpha)
      expect(inspected.stdout).toBe('w1 alpha "Alpha":\n- button "Add" [disabled] [w1.3]\n')
      const missing = await dev.tool(['inspect', '--find', 'Save'], alpha)
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain('acde: no element\'s name or value contains "Save"; ')
      expect((await dev.tool(['inspect'], alpha)).stdout).toBe('snapshot {"window":null,"find":null,"all":false}\n')
      expect((await dev.tool(['act', 'w1.5', 'type', 'hello world'], alpha)).stdout).toBe('type w1.5 "hello world"\n')
      expect((await dev.tool(['act', 'w1.5', 'fail'], alpha)).code).toBe(1)
      const unknown = await dev.tool(['act', 'w1.404', 'click'], alpha)
      expect([unknown.code, unknown.stdout]).toEqual([1, ''])
      expect(unknown.stderr).toBe('acde: act w1.404: there is no such element (any more); '
        + 'acde inspect --find TEXT gives the current refs\n')
      const windows = 'the windows: w0 desktop, w1 "Alpha" (acde inspect lists them)'
      const noWindow = await dev.tool(['inspect', '--window', 'w9'], alpha)
      expect([noWindow.code, noWindow.stderr]).toEqual([1, `acde: no window w9; ${windows}\n`])
      const noQuery = await dev.tool(['query', 'h1', '--window', 'w9'], alpha)
      expect([noQuery.code, noQuery.stderr]).toEqual([1, `acde: no window w9; ${windows}\n`])
      const away = await dev.tool(['act', 'w9.1', 'click'], alpha)
      expect([away.code, away.stderr]).toEqual([1, `acde: act w9.1: no window w9; ${windows}\n`])
      const untyped = await dev.tool(['act', 'w1.5', 'type'], alpha)
      expect([untyped.code, untyped.stderr])
        .toEqual([1, 'acde: act: type needs the text to type: acde act w1.5 type "hello"\n'])
      expect((await dev.tool(['webs', '--session', String(dev.child.pid)], dev.root)).code).toBe(0)
      expect((await dev.tool(['inspect', '--offscreen'], alpha)).code).toBe(0)
      const logged = await dev.tool(['console'], alpha)
      expect(logged.stdout).toBe('   1 log    alpha#7  alpha ready\n')
      expect((await dev.tool(['console', '--level', 'loud'], alpha)).stderr).toContain('--level loud: one of')
      const noRequests = await dev.tool(['network', '--failed'], alpha)
      expect(noRequests.stdout).toBe('')
      expect(noRequests.stderr).toBe('acde: no requests\n')
      expect(noRequests.code).toBe(0)
      const queried = await dev.tool(['query', '[data-testid="add"]', '--window', 'w1'], alpha)
      expect(queried.stdout).toBe('1 in w1:\n- button "Add" [disabled] [w1.3] <button>\n')
      expect(queried.code).toBe(0)
      expect((await dev.tool(['query', '.ghost', '--window=w1'], alpha)).stdout)
        .toBe('1 in w1:\n- generic [w1.99] <div> [hidden]\n')
      const nothing = await dev.tool(['query', 'nav'], alpha)
      expect([nothing.code, nothing.stdout, nothing.stderr]).toEqual([2, '', 'acde: nothing in w1 matches "nav"\n'])
      expect((await dev.tool(['query', '*', '--ref', 'w1.4', '--limit', '5'], alpha)).stderr)
        .toBe('acde: nothing in w1 matches "*"\n')
      expect(dev.entries().findLast((e) => e.got?.['op'] === 'query')?.got)
        .toMatchObject({ selector: '*', ref: 'w1.4', limit: 5 })
      for (const limit of ['0', '3001', 'few']) {
        const refused = await dev.tool(['query', 'li', '--limit', limit], alpha)
        expect([refused.code, refused.stderr]).toEqual([1,
          `acde: query: --limit ${limit}: how many elements to list at most, 1 to 3000 (acde query --help)\n`])
      }
      expect((await dev.tool(['query'], alpha)).stderr).toContain('query: 1 arguments, not 0 (acde query --help)')
      const screen = await dev.tool(['screen', '-o', join(base, 'all.png')], alpha)
      expect(screen.stdout.trim()).toBe(join(base, 'all.png'))
      expect(readFileSync(join(base, 'all.png')).subarray(1, 4).toString()).toBe('PNG')
      expect((await dev.tool(['pointer', '1439', '0'], alpha)).stdout.trim()).toBe('the pointer is at 1439, 0')
      expect((await dev.tool(['pointer', 'left', '0'], alpha)).stderr).toContain('x and y are numbers')

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
      const marked = await until('the reload mark', () =>
        (JSON.parse(readFileSync(file, 'utf8')) as Session).reloaded)
      expect(marked).toEqual({ console: 2, network: 1 })
      const quiet = await dev.tool(['console', '--since', 'reload'], alpha)
      expect(quiet.stdout).toBe('')
      expect(quiet.stderr).toBe('acde: no console entries in that range\n')
      expect((await dev.tool(['console', '--since', '1'], alpha)).stdout).toBe('   1 log    alpha#7  alpha ready\n')
      const wrong = await dev.tool(['network', '--since', 'later'], alpha)
      expect(wrong.code).toBe(1)
      expect(wrong.stderr).toContain('network: --since later: reload, or the number of an entry')
    } finally {
      await dev.stop()
    }
    expect(await dev.child.exited).toBe(0)
    expect(readdirSync(dev.sessions)).toEqual([])
    expect(readdirSync(dev.root).filter((f) => f.endsWith('.sock'))).toEqual([])
    expect((await dev.tool(['webs'], base)).stderr).toContain('no acde dev is running')
    const gone = await dev.tool(['devtools'], base, undefined, { ACDE_BROWSER: 'none' })
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('no acde dev is running')
  }, 120_000)

  test('a file saved atomically (renamed over) is still watched: the next in-place write rebuilds too', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' }, { 'util.js': 'export const v = 0' })
    const dev = start([alpha], base)
    const reloads = () => dev.entries().filter((e) => e.got?.['type'] === 'reload').length
    try {
      await until('the session file', () => existsSync(dev.file))
      await Bun.sleep(200)
      writeFileSync(join(alpha, 'util.js.tmp'), 'export const v = 1')
      renameSync(join(alpha, 'util.js.tmp'), join(alpha, 'util.js'))
      await until('the reload after the atomic save', () => reloads() >= 1)
      await Bun.sleep(400)
      writeFileSync(join(alpha, 'util.js'), 'export const v = 2')
      await until('the reload after the in-place write', () => reloads() >= 2)
      mkdirSync(join(alpha, 'lib'))
      writeFileSync(join(alpha, 'lib', 'more.js'), 'export {}')
      await until('the reload after a file in a new directory', () => reloads() >= 3)
    } finally {
      await dev.stop()
    }
  }, 30_000)

  test('a change of styles and scripts only reloads hot; a change of the page reloads the whole page', async () => {
    const base = tmp()
    const page = (text: string) =>
      '<!doctype html><title>x</title><link rel="stylesheet" href="./style.css">' +
      `<script type="module" src="./main.js"></script><p>${text}</p>`
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' },
      { 'style.css': 'p { color: red }', 'main.js': 'console.log(1)' })
    writeFileSync(join(alpha, 'index.html'), page('x'))
    const dev = start([alpha], base)
    const reloads = () => dev.entries().filter((e) => e.got?.['type'] === 'reload').map((e) => e.got)
    try {
      await until('the session file', () => existsSync(dev.file))
      await Bun.sleep(200)
      writeFileSync(join(alpha, 'style.css'), 'p { color: blue }')
      await until('the hot reload', () => reloads().length >= 1)
      writeFileSync(join(alpha, 'main.js'), 'console.log(2)')
      await until('the second hot reload', () => reloads().length >= 2)
      writeFileSync(join(alpha, 'index.html'), page('y'))
      await until('the full reload', () => reloads().length >= 3)
      expect(reloads()).toEqual([
        { type: 'reload', app: 'alpha', hot: true },
        { type: 'reload', app: 'alpha', hot: true },
        { type: 'reload', app: 'alpha' },
      ])
    } finally {
      await dev.stop()
    }
  }, 30_000)

  test('a hand-written package: its sources do not reload; what it serves (dist/) does, hot when it can', async () => {
    const base = tmp()
    const hand = join(base, 'hand')
    mkdirSync(join(hand, 'dist'), { recursive: true })
    mkdirSync(join(hand, 'src'))
    writeFileSync(join(hand, 'package.json'), JSON.stringify({
      name: 'hand',
      acde: {
        apiLevel: API_LEVEL,
        apps: [{ id: 'hand', label: 'Hand', icon: 'app', entry: '/app/hand/index.html' }],
        assets: { '/app/hand/': ['dist'] },
      },
    }))
    const page = (text: string) => `<!doctype html><script type="module" src="main.js"></script><p>${text}</p>`
    writeFileSync(join(hand, 'dist', 'index.html'), page('x'))
    writeFileSync(join(hand, 'dist', 'main.js'), 'console.log(1)')
    writeFileSync(join(hand, 'src', 'main.ts'), 'console.log(1)')
    const dev = start([realpathSync(hand)], base)
    const reloads = () => dev.entries().filter((e) => e.got?.['type'] === 'reload').map((e) => e.got)
    try {
      await until('the session file', () => existsSync(dev.file))
      await Bun.sleep(200)
      writeFileSync(join(hand, 'src', 'main.ts'), 'console.log(2)')
      await Bun.sleep(800)
      expect(reloads()).toEqual([])
      writeFileSync(join(hand, 'dist', 'main.js'), 'console.log(2)')
      await until('the hot reload', () => reloads().length >= 1)
      writeFileSync(join(hand, 'dist', 'index.html'), page('y'))
      await until('the full reload', () => reloads().length >= 2)
      expect(reloads()).toEqual([{ type: 'reload', app: 'hand', hot: true }, { type: 'reload', app: 'hand' }])
    } finally {
      await dev.stop()
    }
  }, 30_000)

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

  test('keeps: what the pages and backends print, what happens to apps, warnings and errors; not the runtime\'s own log', () => {
    for (const line of [
      '6975.356 I acde js: PAGE-LOG-MARKER',
      '16152.936 D acde js: console.debug',
      '16153.027 W acde js: console.warn',
      '123.456 I acde-child-out acdert::child: [app#backend] hi',
      '123.457 I acde-child-out acdert::backends: [app#backend] hi',
      '38.157 I acde acde_host: [withapi#backend] started (pid 5135, port 3000)',
      '15489.032 I acde acde_host: [withapi#1048576] acde dev: state restored (0 kept)',
      '16153.128 I acde acde_host: [ledger#1048576] alert: hi',
      '21.000 I acde acde_host: Ledger (ledger) waits for the user to allow "camera" (prompt 1; answer it with acde allow '
        + 'or acde deny, the acde driver, or acde:permissions)',
      '22.000 I acde acde_host: color scheme: dark (emulated)',
      '14.383 W main acde_hostwin: a warning',
      '14.384 E acde acde_host: an error',
      'line',
      '',
      'thread \'main\' panicked at src/main.rs:1:1:',
    ]) expect([line, DevSession.keeps(line)]).toEqual([line, true])
    for (const line of [
      '13.611 I main acde_hostwin::output::gpu: web layer uses Apple M3 Pro (IntegratedGpu, Metal)',
      '30.096 I acde acde_host: startup: shell created ms=30',
      '32.130 I acde acde_host: broker started (2ms)',
      '22700.843 I acde acde_host: ended (signal), exit 0',
      '22700.844 I acde acde_host: session logout, exit 0',
      '15442.335 I acde-dev-conn acde_hostwin::dev: acde dev: reload withapi',
      '95.000 I acde acdert::backends: removed /tmp/b/app, left by an acdert that is gone',
      '19.236 D acde-warm acde_render::gpu: [vello] warm-up',
      '20.000 T acde acde_host: [app#1] traced',
    ]) expect([line, DevSession.keeps(line)]).toEqual([line, false])
  })

  test('without --verbose the runtime\'s own info log is left out; page, backend, warnings and errors are not', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const kept = [
      '12.345 I acde js: fake acdert is up',
      '14.383 W main acde_hostwin: fake warning',
      '14.384 E acde acde_host: fake error',
      '14.386 I acde acde_host: [alpha#backend] started (pid 4242, port 3000)',
      '14.387 I acde-child-out acdert::child: [alpha#backend] fake backend output',
      '14.388 I acde-child-out acdert::backends: [alpha#backend] fake channel backend output',
      '14.390 I acde js: fake page log\nand its second line',
      '14.391 D acde js: fake page debug',
      '14.392 W acde js: fake page warning',
      '14.393 I acde acde_host: [alpha#7] alert: fake alert',
      '14.394 I acde acde_host: Alpha (alpha) waits for the user to allow "camera" (prompt 1; fake)',
      'thread \'main\' panicked at fake.rs:1:1:',
    ]
    const dropped = ['fake adapter', 'fake shell running', 'fake-sockets', 'reload alpha', 'broker started', 'fake debug']
    for (const verbose of [false, true]) {
      const dev = start(verbose ? [alpha, '--verbose'] : [alpha], base, { FAKE_ACDERT_LOGS: '1' })
      await until('the session file', () => existsSync(dev.file))
      await dev.stop()
      const said = await dev.output
      for (const line of kept) expect(said).toContain(`${line}\n`)
      for (const word of dropped) expect([word, said.includes(word)]).toEqual([word, verbose])
    }
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
    expect(readdirSync(dev.sessions).filter((f) => f.startsWith(`${dev.child.pid}.`))).toEqual([])

    Sessions.write({ ...session, pid: process.pid }, dev.sessions)
    const reused = await dev.tool(['webs'], alpha)
    expect(reused.code).toBe(1)
    expect(reused.stderr).toContain(`acde dev ${process.pid} is gone`)
    expect(readdirSync(dev.sessions).filter((f) => f.endsWith('.json'))).toEqual([])
  }, 30_000)

  test('a second acde dev on the same project is refused; SIGINT to acde dev alone ends it and its files; '
    + 'a session file whose pid now belongs to another process refuses nothing and is dropped', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const root = tmp()
    const left: Session = {
      pid: process.pid, endpoint: testEndpoint(), dirs: [alpha], apps: ['alpha'], desktop: null, started: 1,
    }
    Sessions.write(left, join(root, 'acde-dev'))
    const dev = start([alpha], base, {}, root)
    let stopped = false
    try {
      await until('the session file', () => existsSync(dev.file))
      expect(existsSync(Sessions.file(process.pid, dev.sessions))).toBe(false)
      const acdert = fakeAcdert(dev.root)
      const pid = dev.child.pid
      const second = await dev.tool(['dev', alpha, '--headless'], base, undefined, { ACDERT: acdert })
      expect(second.code).toBe(1)
      expect(second.stderr).toBe(`acde: acde dev ${pid} already runs ${realpathSync(alpha)}; `
        + `stop it first (acde stop --session ${pid}), or pass --force to start another\n`)
      if (!WINDOWS) {
        dev.child.kill('SIGINT')
        const ended = await Promise.race([dev.child.exited.then(() => 'ended'), Bun.sleep(3_000).then(() => 'late')])
        expect(ended).toBe('ended')
        stopped = true
        expect(readdirSync(dev.sessions).filter((f) => f.startsWith(`${pid}.`))).toEqual([])
      }
    } finally {
      if (!stopped) await dev.stop()
    }
  }, 30_000)

  test('a session of acde test says so in its file, keeps the marker from acdert, and is passed by: ' +
    'a plain acde dev starts beside it and the tools in the project pick the plain one', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const tested = start([alpha, '--headless', '--force'], base, { ACDE_TEST_SESSION: '1' })
    try {
      await until('the session file of the test', () => existsSync(tested.file))
      const marked = JSON.parse(readFileSync(tested.file, 'utf8')) as Session
      expect(marked.test).toBe(true)
      const started = tested.entries().find((e) => e.argv) as { env?: Record<string, string | null> }
      expect(started.env!['ACDE_TEST_SESSION']).toBeNull()
      const only = await tested.tool(['webs'], alpha)
      expect(only.code).toBe(1)
      expect(only.stderr).toContain('no acde dev is running, only sessions of acde test')
      const reached = await tested.tool(['webs', '--session', String(tested.child.pid)], alpha)
      expect(reached.code).toBe(0)
      expect(reached.stdout).toContain('alpha#7')
      const plain = start([alpha, '--headless'], base, {}, tested.root)
      try {
        await until('the session file of the plain acde dev', () => existsSync(plain.file))
        expect((JSON.parse(readFileSync(plain.file, 'utf8')) as Session).test).toBeUndefined()
        const listed = await tested.tool(['webs'], alpha)
        expect(listed.code).toBe(0)
      } finally {
        await plain.stop()
      }
    } finally {
      await tested.stop()
    }
  }, 30_000)

  test('two acde dev started at the same moment on one project: one runs, the other is refused; the claim of a '
    + 'killed acde dev holds nothing; a running acde dev --force still refuses a plain one', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const root = tmp()
    const both = [start([alpha, '--headless'], base, {}, root), start([alpha, '--headless'], base, {}, root)]
    try {
      const first = both.map((dev) => dev.child.exited.then((c) => [dev, c] as const))
      const late = Bun.sleep(15_000).then(() => [null, null] as const)
      const [loser, code] = await Promise.race([...first, late])
      if (loser === null) throw new Error('both acde dev still run after 15 s: neither was refused')
      const winner = both.find((dev) => dev !== loser)!
      expect(code).toBe(1)
      expect(await loser.output).toBe(`acde: acde dev ${winner.child.pid} already runs ${alpha}; `
        + `stop it first (acde stop --session ${winner.child.pid}), or pass --force to start another\n`)
      await until('the session file of the one that runs', () => existsSync(winner.file))
      winner.child.kill('SIGKILL')
      await winner.child.exited
      expect(readdirSync(winner.sessions).filter((name) => name.endsWith('.claim'))).toHaveLength(1)
    } finally {
      for (const dev of both) dev.child.kill('SIGKILL')
    }
    const next = start([alpha, '--headless'], base, {}, root)
    let forced: ReturnType<typeof start> | null = null
    try {
      await until('the session file after the killed one', () => existsSync(next.file))
      forced = start([alpha, '--headless', '--force', '--out', join(base, 'forced')], base, {}, root)
      const file = forced.file
      await until('the session file of the forced one', () => existsSync(file))
      expect(await next.stop()).toBe(0)
      const plain = await next.tool(['dev', alpha, '--headless'], base, undefined, { ACDERT: fakeAcdert(root) })
      expect(plain.code).toBe(1)
      expect(plain.stderr).toContain(`acde: acde dev ${forced.child.pid} already runs ${alpha}`)
    } finally {
      await forced?.stop()
      if (next.child.exitCode === null) await next.stop()
    }
    Sessions.list(join(root, 'acde-dev'))
    expect(readdirSync(join(root, 'acde-dev'))).toEqual([])
  }, 60_000)

  test.skipIf(skipping(WINDOWS, 'SIGINT to one process: Unix only'))('through the launcher (bin/acde.mjs): SIGINT to '
    + 'the launcher alone ends acde dev; one Ctrl+C to the whole group is one interrupt; a second one later forces',
  async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const launch = (linger: number) => {
      const root = tmp()
      const log = join(root, 'fake.log')
      writeFileSync(log, '')
      const vars = {
        TMPDIR: root, XDG_RUNTIME_DIR: root, ACDERT: fakeAcdert(root), FAKE_ACDERT_LOG: log,
        FAKE_ACDERT_LINGER_MS: String(linger),
      }
      const launcher = spawn(process.execPath, [LAUNCHER, 'dev', alpha, '--headless'], {
        cwd: base, env: env(vars), stdio: 'ignore', detached: true,
      })
      const exited = new Promise<number | null>((done) => launcher.once('exit', (code) => done(code)))
      const sessions = join(root, 'acde-dev')
      const signals = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
        .map((l) => (JSON.parse(l) as { signal?: string }).signal).filter(Boolean)
      const ready = () => until('a session', () => existsSync(sessions)
        && readdirSync(sessions).find((name) => name.endsWith('.json')))
      const within = (ms: number) => Promise.race([exited, Bun.sleep(ms).then(() => 'late' as const)])
      const group = (signal: NodeJS.Signals) => {
        try {
          process.kill(-launcher.pid!, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      return { launcher, sessions, signals, ready, within, group }
    }
    const alone = launch(300)
    try {
      await alone.ready()
      alone.launcher.kill('SIGINT')
      expect(await alone.within(5_000)).toBe(0)
      expect(alone.signals()).toEqual(['SIGTERM'])
      expect(readdirSync(alone.sessions)).toEqual([])
    } finally {
      alone.group('SIGKILL')
    }
    const group = launch(1_000)
    try {
      await group.ready()
      group.group('SIGINT')
      expect(await group.within(5_000)).toBe(0)
      expect(group.signals().sort()).toEqual(['SIGINT', 'SIGTERM'])
    } finally {
      group.group('SIGKILL')
    }
    const twice = launch(10_000)
    try {
      await twice.ready()
      twice.group('SIGINT')
      await Bun.sleep(1_000)
      twice.group('SIGINT')
      expect(await twice.within(5_000)).toBe(137)
    } finally {
      twice.group('SIGKILL')
    }
  }, 60_000)

  test('act w1 close that ends a single-app session exits 0, any other lost connection 1; ' +
    'acde stop ends a session in the background', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const closing = start([], alpha)
    await until('the session file', () => existsSync(closing.file))
    const closed = await closing.tool(['act', 'w1', 'close'], alpha)
    expect(closed.stderr).toBe('')
    expect(closed.stdout).toBe(`closed w1; acdebin-dbg exited with it, so acde dev ${closing.child.pid} ended\n`)
    expect(closed.code).toBe(0)
    expect(await closing.child.exited).toBe(0)

    const crashing = start([], alpha, { FAKE_ACDERT_DIES_ON: 'focus' })
    await until('the session file', () => existsSync(crashing.file))
    const lost = await crashing.tool(['act', 'w1', 'focus'], alpha)
    expect([lost.code, lost.stdout, lost.stderr]).toEqual([1, '', 'acde: acdebin-dbg closed the connection\n'])
    await crashing.child.exited

    const desktop = start(['--desktop', 'dopame'], alpha, { FAKE_ACDERT_DIES_ON: 'close' })
    await until('the session file', () => existsSync(desktop.file))
    const crashed = await desktop.tool(['act', 'w1', 'close'], alpha)
    expect([crashed.code, crashed.stdout, crashed.stderr]).toEqual([1, '', 'acde: acdebin-dbg closed the connection\n'])
    await desktop.child.exited

    const stopping = start([], alpha)
    await until('the session file', () => existsSync(stopping.file))
    const began = performance.now()
    const stopped = await stopping.tool(['stop'], alpha)
    expect(performance.now() - began).toBeLessThan(2_000)
    expect(stopped.stdout).toBe(`acde: stopped acde dev ${stopping.child.pid}\n`)
    expect(stopped.code).toBe(0)
    expect(await stopping.child.exited).toBe(0)
    expect(existsSync(stopping.file)).toBe(false)
    expect(stopping.entries().some((e) => e.got?.['type'] === 'quit')).toBe(true)
    const none = await stopping.tool(['stop'], alpha)
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('no acde dev is running')
  }, 30_000)

  test('acde devtools against a runtime that answers only a port: no token in the list or the address', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { FAKE_ACDERT_DEVTOOLS_TOKENLESS: '1' })
    try {
      await until('the session file', () => existsSync(dev.file))
      const opened = await dev.tool(['devtools', 'alpha'], alpha, undefined, { ACDE_BROWSER: 'none' })
      expect(opened.code, opened.stderr).toBe(0)
      expect(opened.stdout)
        .toMatch(/^devtools:\/\/devtools\/bundled\/devtools_app\.html\?ws=127\.0\.0\.1%3A\d+%2Fdevtools%2Fpage%2F7\n$/)
      expect(dev.entries().some((e) => (e as { devtools?: string }).devtools === '/json/list')).toBe(true)
    } finally {
      await dev.stop()
    }
  }, 60_000)

  test('acde devtools starts the browser on its own profile, opens the front end with Target.createTarget, '
    + 'then reuses that browser and brings an open front end to the front', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha)
    const cache = join(base, 'cache')
    const log = join(base, 'browser.log')
    writeFileSync(log, '')
    const browser = fakeBrowser(base)
    const vars = {
      ACDE_BROWSER: browser, FAKE_BROWSER_LOG: log, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, HOME: base,
      USERPROFILE: base,
    }
    type Said = { started?: string[]; pid?: number; method?: string; params?: { url?: string; targetId?: string } }
    const said = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Said)
    try {
      await until('the session file', () => existsSync(dev.file))
      const first = await dev.tool(['devtools', 'alpha'], alpha, undefined, vars)
      expect(first.code, first.stderr).toBe(0)
      expect(first.stderr).toContain(`acde: opened DevTools for Alpha in ${browser}`)
      const url = first.stdout.trim()
      expect(url).toStartWith('devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1%3A')
      const started = said().filter((entry) => entry.started)
      expect(started).toHaveLength(1)
      const profile = started[0]!.started!.find((arg) => arg.startsWith('--user-data-dir='))!.slice(16)
      const caches = process.platform === 'darwin' ? join(base, 'Library', 'Caches') : cache
      expect(profile.startsWith(join(caches, 'acde', 'devtools'))).toBe(true)
      expect(started[0]!.started).toContain('--remote-debugging-port=0')
      expect(started[0]!.started).toContain('--no-startup-window')
      expect(started[0]!.started).toContain('--disable-sync')
      expect(started[0]!.started).not.toContain(url)
      expect(said().filter((entry) => entry.method === 'Target.createTarget').map((entry) => entry.params?.url))
        .toEqual([url])
      const again = await dev.tool(['devtools', 'alpha'], alpha, undefined, vars)
      expect(again.code, again.stderr).toBe(0)
      expect(again.stderr).toContain(`acde: brought DevTools for Alpha to the front in ${browser}`)
      expect(said().filter((entry) => entry.started)).toHaveLength(1)
      expect(said().filter((entry) => entry.method === 'Target.createTarget')).toHaveLength(1)
      expect(said().filter((entry) => entry.method === 'Target.activateTarget').map((entry) => entry.params))
        .toEqual([{ targetId: 'fake-target-1' }])
      const desk = await dev.tool(['devtools', 'desktop'], alpha, undefined, vars)
      expect(desk.stderr).toContain(`acde: opened DevTools for Desk in ${browser}`)
      expect(said().filter((entry) => entry.method === 'Target.createTarget')).toHaveLength(2)
      const nowhere = { ...vars, ACDE_BROWSER: join(base, 'nope') }
      const missing = await dev.tool(['devtools', 'alpha'], alpha, undefined, nowhere)
      expect(missing.code, missing.stderr).toBe(0)
      expect(missing.stdout.trim()).toBe(url)
      expect(missing.stderr).toContain('could not open it in')
      expect(missing.stderr).toContain('paste the address above into the address bar of Chrome or Edge')
    } finally {
      for (const entry of said()) {
        try {
          if (entry.pid) process.kill(entry.pid)
        } catch {}
      }
      await dev.stop()
    }
  }, 60_000)

  test('F12 in a host window: acde dev opens DevTools on the page acdert names, prints the address when no browser '
    + 'opens it, once per press, and a page with no target only prints why', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { ACDE_BROWSER: 'none' })
    let link: DevClient | null = null
    try {
      await until('the session file', () => existsSync(dev.file))
      const session = JSON.parse(readFileSync(dev.file, 'utf8')) as Session
      link = await DevClient.connect(session.endpoint)
      expect(await link.request('press-f12', { web: 'alpha#7' })).toEqual({ told: 1 })
      await link.request('press-f12', { web: 'alpha#7' })
      await link.request('press-f12', { web: 'gone#3' })
      await until('three DevTools listings', () =>
        dev.entries().filter((e) => (e as { devtools?: string }).devtools?.startsWith('/json/list')).length >= 3)
      link.close()
      link = null
      await Bun.sleep(300)
    } finally {
      link?.close()
      await dev.stop()
    }
    const output = await dev.output
    const address = /devtools:\/\/devtools\/bundled\/devtools_app\.html\?ws=127\.0\.0\.1%3A\d+%2Fdevtools%2Fpage%2F7%3Ftoken%3Dfake-token\n/g
    expect(output.match(address)).toHaveLength(2)
    expect(output.split('acde: DevTools for Alpha: ACDE_BROWSER=none: no browser opened; paste').length - 1).toBe(2)
    expect(output).toContain('acde: F12: no DevTools target for gone#3; the targets are:')
  }, 60_000)

  test('F12 with a browser: the first press opens DevTools, the next brings it to the front', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const cache = join(base, 'cache')
    const log = join(base, 'browser.log')
    writeFileSync(log, '')
    const browser = fakeBrowser(base)
    const dev = start([], alpha, {
      ACDE_BROWSER: browser, FAKE_BROWSER_LOG: log, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, HOME: base, USERPROFILE: base,
    })
    type Said = { pid?: number; method?: string; params?: { url?: string } }
    const said = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Said)
    let link: DevClient | null = null
    try {
      await until('the session file', () => existsSync(dev.file))
      const session = JSON.parse(readFileSync(dev.file, 'utf8')) as Session
      link = await DevClient.connect(session.endpoint)
      await link.request('press-f12', { web: 'alpha#7' })
      await until('the front end', () => said().find((e) => e.method === 'Target.createTarget'))
      await link.request('press-f12', { web: 'alpha#7' })
      await until('the front end brought forward', () => said().find((e) => e.method === 'Target.activateTarget'))
      expect(said().filter((e) => e.method === 'Target.createTarget')).toHaveLength(1)
      link.close()
      link = null
    } finally {
      link?.close()
      for (const entry of said()) {
        try {
          if (entry.pid) process.kill(entry.pid)
        } catch {}
      }
      await dev.stop()
    }
    const output = await dev.output
    expect(output).toContain(`acde: opened DevTools for Alpha in ${browser}`)
    expect(output).toContain(`acde: brought DevTools for Alpha to the front in ${browser}`)
    expect(output).not.toContain('devtools://')
  }, 60_000)

  test('approval prompts from the command line: permissions, allow, deny, revoke; ' +
    'webs says what an app waits for', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { FAKE_ACDERT_WAITS: '1' })
    try {
      await until('the session file', () => existsSync(dev.file))
      const said = async (...argv: string[]) => {
        const ran = await dev.tool(argv, alpha)
        return [ran.code, ran.stdout, ran.stderr]
      }
      const hints = 'alpha waits for approval of camera: acde allow (or acde deny)\n' +
        'beta waits for approval of microphone: acde allow (or acde deny)\n'
      const webs = await said('webs')
      expect(webs[1]).toContain('alpha#7  app      alpha  7       Alpha\n')
      expect(webs[1]).toEndWith(hints)
      const waiting = '  1  alpha  camera  (request)\n  2  beta  microphone  (request)\n'
      expect(await said('permissions')).toEqual([0, `pending:\n${waiting}decisions: none\n`, ''])
      const several =
        `acde: 2 approval prompts wait; name one (its id, or <app> <capability>) or pass --all:\n${waiting}`
      expect(await said('allow')).toEqual([1, '', several])
      expect(await said('deny')).toEqual([1, '', several])
      expect(await said('allow', '7')).toEqual([1, '', 'acde: no approval prompt 7 is waiting (waiting: 1, 2)\n'])
      expect(await said('deny', 'alpha', 'network'))
        .toEqual([1, '', 'acde: no approval prompt of alpha for network is waiting (waiting: 1, 2)\n'])
      expect(await said('allow', 'alpha')).toEqual([1, '', 'acde: allow: alpha is not a prompt id ' +
        '(acde permissions lists them); or give <app> <capability> (acde allow --help)\n'])
      expect(await said('deny', '1', '--all')).toEqual([1, '',
        'acde: deny: --all answers every waiting prompt; leave the prompt out (acde deny --help)\n'])
      expect((await dev.tool(['allow', 'a', 'b', 'c'], alpha)).stderr)
        .toContain('allow: 0 to 2 arguments, not 3 (acde allow --help)')
      expect(dev.entries().some((e) => e.got?.['op'] === 'answer')).toBe(false)

      expect(await said('allow', 'alpha', 'camera')).toEqual([0, 'allowed alpha camera (prompt 1)\n', ''])
      expect((await dev.tool(['webs'], alpha)).stdout).toEndWith('beta waits for approval of microphone: acde allow (or acde deny)\n')
      expect(await said('deny')).toEqual([0, 'denied beta microphone (prompt 2)\n', ''])
      const decided = '  alpha  camera  granted\n  beta  microphone  denied\n'
      expect(await said('permissions')).toEqual([0, `pending: none\ndecisions:\n${decided}`, ''])
      expect(await said('allow')).toEqual([1, '', 'acde: no approval prompt is waiting\n'])
      expect(await said('deny', '--all')).toEqual([1, '', 'acde: no approval prompt is waiting\n'])
      expect(await said('allow', 'beta', 'microphone')).toEqual([1, '', 'acde: no approval prompt of beta for ' +
        'microphone is waiting: it is already denied (revoke takes that back)\n'])
      expect(await said('revoke', 'beta', 'microphone')).toEqual([0, 'revoked beta microphone\n', ''])
      expect(await said('revoke', 'beta', 'microphone')).toEqual([1, '',
        'acde: no decision about beta microphone to revoke (permissions lists the decisions)\n'])
      expect((await dev.tool(['revoke', 'beta'], alpha)).stderr)
        .toContain('revoke: 2 arguments, not 1 (acde revoke --help)')
      const sent = dev.entries()
        .flatMap((e) => (e.got?.['op'] === 'answer' ? [[e.got['prompt'], e.got['allow']]] : []))
      expect(sent).toEqual([[1, true], [2, false]])
    } finally {
      await dev.stop()
    }

    const all = start([], alpha, { FAKE_ACDERT_WAITS: '1' })
    try {
      await until('the session file', () => existsSync(all.file))
      const allowed = await all.tool(['allow', '--all'], alpha)
      expect([allowed.code, allowed.stdout])
        .toEqual([0, 'allowed alpha camera (prompt 1)\nallowed beta microphone (prompt 2)\n'])
    } finally {
      await all.stop()
    }
  }, 60_000)

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

  test('acde eval while acde dev rebuilds and reloads again and again finds the one session every time', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([alpha], base)
    try {
      await until('the session file', () => existsSync(dev.file))
      let changes = 0
      const touching = setInterval(() => writeFileSync(join(alpha, 'index.html'), `<p>${changes++}</p>`), 120)
      try {
        for (let i = 0; i < 12; i++) {
          for (const from of [alpha, base]) {
            const ran = await dev.tool(['eval', 'alpha', '1'], from)
            expect(ran.stderr).not.toContain('acde dev sessions runs')
            expect(ran.stderr).not.toContain('no acde dev is running')
            expect([ran.code, ran.stderr]).toEqual([0, from === base ? expect.stringContaining('the only one') : ''])
          }
        }
      } finally {
        clearInterval(touching)
      }
      expect(changes).toBeGreaterThan(3)
    } finally {
      await dev.stop()
    }
  }, 60_000)

  test('mistakes: --out with several projects, --app with several, the same app twice, two desktops', async () => {
    const base = tmp()
    const a = project(join(base, 'a'), { type: 'app', id: 'same' })
    const b = project(join(base, 'b'), { type: 'app', id: 'same' })
    const d1 = project(join(base, 'd1'), { type: 'desktop', id: 'd1' })
    const d2 = project(join(base, 'd2'), { type: 'desktop', id: 'd2' })
    const cases: [string[], string][] = [
      [[a, d1, '--out', join(base, 'x')], '--out is for one project'],
      [[a, d1, '--app', 'same'], '--app picks the window of one project'],
      [[a, '--app', 'nope'], '--app nope: not an app id of this project (its apps: same); --app takes an app id\n'],
      [[a, '--app', a], `--app ${a}: not an app id of this project (its apps: same); --app takes an app id; `
        + `give a directory as the first argument: acde dev ${a}`],
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
