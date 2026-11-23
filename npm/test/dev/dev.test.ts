import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevClient, Lines, type Message } from '../../src/ipc.ts'
import { Claims, Sessions, type Session } from '../../src/sessions.ts'
import { Format } from '../../src/driver/format.ts'
import { slug } from '../../src/paths.ts'
import { cleanup, line, skipping, testEndpoint, tmp, until, WINDOWS } from '../helpers.ts'

afterAll(cleanup)

class FakeAcdert {
  readonly got: Message[] = []
  readonly server: net.Server
  readonly sockets: net.Socket[] = []
  answer: (request: Message, socket: net.Socket) => void = () => undefined

  readonly endpoint: string

  constructor(endpoint: string) {
    this.endpoint = endpoint
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

describe('dev IPC: tools and acdev dev talk to acdert directly', () => {
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

  unixOnly('session dir modes and socket files: Unix only')('acdev dev prepares a private session dir and clears ' +
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
    expect(timeout).toBe('timed out: acdev runtime did not answer "eval" within 0 s')
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
    expect(said).toEqual([expect.stringMatching(/^acdev: using acdev dev 13 \(.+\), the only one running$/)])
    expect(Sessions.pick([a, ab, c], join(root, 'a'), undefined, (line) => said.push(line)).pid).toBe(11)
    expect(said).toHaveLength(1)
    expect(Sessions.pick([a, ab, c], join(root, 'elsewhere'), 13).pid).toBe(13)
    expect(() => Sessions.pick([a, c], join(root, 'elsewhere')))
      .toThrow(/^none of the 2 acdev dev sessions runs .*elsewhere; pick one with --session <pid>:\n {2}11 {2}app alpha/)
    expect(() => Sessions.pick([a, { ...a, pid: 14 }], join(root, 'a'))).toThrow('several acdev dev sessions run')
    expect(() => Sessions.pick([], root)).toThrow('no acdev dev is running')
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other', 'acde.config.jsonc'), '{}')
    const other = `no acdev dev runs the project in ${join(root, 'other')}; `
      + 'to use another one, pass --session <pid>:\n  13'
    expect(() => Sessions.pick([c], join(root, 'other'))).toThrow(other)
    expect(Sessions.pick([c], join(root, 'other'), 13).pid).toBe(13)
    expect(() => Sessions.pick([a], root, 99)).toThrow('no acdev dev with pid 99:\n  11')
  })

  test('claims: one holder per project, even one whose event loop is blocked; a dead or reused holder is taken '
    + 'over; a refused claim keeps nothing; release removes only its own', async () => {
    const dir = join(tmp(), 'acde-dev')
    const project = realpathSync(tmp())
    const other = realpathSync(tmp())
    const script = join(tmp(), 'hold.ts')
    writeFileSync(script, `import { Claims } from ${JSON.stringify(join(import.meta.dir, '../../src/sessions.ts'))}
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

  test('sessions of acdev test: pick and running pass them by; --session still reaches them', () => {
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
    expect(said).toEqual([expect.stringMatching(/^acdev: using acdev dev 11 \(app alpha\), the only one running$/)])
    expect(() => Sessions.pick([tested], join(root, 'a')))
      .toThrow(new RegExp('^no acdev dev is running, only sessions of acdev test, which are reached only with --session <pid>:\\n'
        + ' {2}12 {2}app alpha \\(headless, acdev test\\)'))
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
    expect(Format.webs([
      { name: 'desktop', app: null, kind: 'desktop', window: 0, title: 'Dopame', lock: false },
      { name: 'lock', app: null, kind: 'desktop', window: 2, title: 'Lock', lock: true },
    ], true)).toBe([
      'NAME     KIND     APP  WINDOW  LOCK  TITLE',
      'desktop  desktop  -    0       -     Dopame',
      'lock     desktop  -    2       lock  Lock',
      'locked: yes (the lock page is up)',
    ].join('\n'))
    expect(Format.webs([
      { name: 'desktop', app: null, kind: 'desktop', window: 0, title: 'Dopame' },
      { name: 'desk-panel#1', app: 'desk-panel', kind: 'app', window: 4, title: null, stalled: true },
    ])).toBe([
      'NAME          KIND     APP         WINDOW  TITLE',
      'desktop       desktop  -           0       Dopame',
      'desk-panel#1  app      desk-panel  4       (not answering)',
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
