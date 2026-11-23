import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_LEVEL } from '../../src/manifest/index.ts'
import { DevClient } from '../../src/ipc.ts'
import { Sessions, type Session } from '../../src/sessions.ts'
import {
  cleanup, env, fakeAcdert, fakeBrowser, skipping, testEndpoint, tmp, until, WINDOWS,
} from '../helpers.ts'
import { project, start } from './standin.ts'

const LAUNCHER = join(import.meta.dir, '../../bin/acdev.mjs')

afterAll(cleanup)

describe('acdev dev with a stand-in acdert', () => {
  test('acdev dev killed from outside: acdert follows; the next tool drops the session file it left', async () => {
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
    expect(webs.stderr).toContain('no acdev dev is running')
    expect(readdirSync(dev.sessions).filter((f) => f.endsWith('.json'))).toEqual([])
    expect(readdirSync(dev.sessions).filter((f) => f.startsWith(`${dev.child.pid}.`))).toEqual([])

    Sessions.write({ ...session, pid: process.pid }, dev.sessions)
    const reused = await dev.tool(['webs'], alpha)
    expect(reused.code).toBe(1)
    expect(reused.stderr).toContain(`acdev dev ${process.pid} is gone`)
    expect(readdirSync(dev.sessions).filter((f) => f.endsWith('.json'))).toEqual([])
  }, 30_000)

  test('a second acdev dev on the same project is refused; SIGINT to acdev dev alone ends it and its files; '
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
      const second = await dev.tool(['dev', alpha, '--headless'], base, undefined, { ACDEV_RUNTIME: acdert })
      expect(second.code).toBe(1)
      expect(second.stderr).toBe(`acdev: acdev dev ${pid} already runs ${realpathSync(alpha)}; `
        + `stop it first (acdev stop --session ${pid}), or pass --force to start another\n`)
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

  test('a session of acdev test says so in its file, keeps the marker from acdert, and is passed by: ' +
    'a plain acdev dev starts beside it and the tools in the project pick the plain one', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const tested = start([alpha, '--headless', '--force'], base, { ACDEV_TEST_SESSION: '1' })
    try {
      await until('the session file of the test', () => existsSync(tested.file))
      const marked = JSON.parse(readFileSync(tested.file, 'utf8')) as Session
      expect(marked.test).toBe(true)
      const started = tested.entries().find((e) => e.argv) as { env?: Record<string, string | null> }
      expect(started.env!['ACDEV_TEST_SESSION']).toBeNull()
      const only = await tested.tool(['webs'], alpha)
      expect(only.code).toBe(1)
      expect(only.stderr).toContain('no acdev dev is running, only sessions of acdev test')
      const reached = await tested.tool(['webs', '--session', String(tested.child.pid)], alpha)
      expect(reached.code).toBe(0)
      expect(reached.stdout).toContain('alpha#7')
      const plain = start([alpha, '--headless'], base, {}, tested.root)
      try {
        await until('the session file of the plain acdev dev', () => existsSync(plain.file))
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

  test('two acdev dev started at the same moment on one project: one runs, the other is refused; the claim of a '
    + 'killed acdev dev holds nothing; a running acdev dev --force still refuses a plain one', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const root = tmp()
    const both = [start([alpha, '--headless'], base, {}, root), start([alpha, '--headless'], base, {}, root)]
    try {
      const first = both.map((dev) => dev.child.exited.then((c) => [dev, c] as const))
      const late = Bun.sleep(15_000).then(() => [null, null] as const)
      const [loser, code] = await Promise.race([...first, late])
      if (loser === null) throw new Error('both acdev dev still run after 15 s: neither was refused')
      const winner = both.find((dev) => dev !== loser)!
      expect(code).toBe(1)
      expect(await loser.output).toBe(`acdev: acdev dev ${winner.child.pid} already runs ${alpha}; `
        + `stop it first (acdev stop --session ${winner.child.pid}), or pass --force to start another\n`)
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
      const plain = await next.tool(['dev', alpha, '--headless'], base, undefined, { ACDEV_RUNTIME: fakeAcdert(root) })
      expect(plain.code).toBe(1)
      expect(plain.stderr).toContain(`acdev: acdev dev ${forced.child.pid} already runs ${alpha}`)
    } finally {
      await forced?.stop()
      if (next.child.exitCode === null) await next.stop()
    }
    Sessions.list(join(root, 'acde-dev'))
    expect(readdirSync(join(root, 'acde-dev'))).toEqual([])
  }, 60_000)

  test.skipIf(skipping(WINDOWS, 'SIGINT to one process: Unix only'))('through the launcher (bin/acdev.mjs): SIGINT to '
    + 'the launcher alone ends acdev dev; one Ctrl+C to the whole group is one interrupt; a second one later forces',
  async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const launch = (linger: number) => {
      const root = tmp()
      const log = join(root, 'fake.log')
      writeFileSync(log, '')
      const vars = {
        TMPDIR: root, XDG_RUNTIME_DIR: root, ACDEV_RUNTIME: fakeAcdert(root), FAKE_ACDERT_LOG: log,
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
    'acdev stop ends a session in the background', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const closing = start([], alpha)
    await until('the session file', () => existsSync(closing.file))
    const closed = await closing.tool(['act', 'w1', 'close'], alpha)
    expect(closed.stderr).toBe('')
    expect(closed.stdout).toBe(`closed w1; acdev runtime exited with it, so acdev dev ${closing.child.pid} ended\n`)
    expect(closed.code).toBe(0)
    expect(await closing.child.exited).toBe(0)

    const crashing = start(['--headless'], alpha, { FAKE_ACDERT_DIES_ON: 'focus' })
    await until('the session file', () => existsSync(crashing.file))
    const lost = await crashing.tool(['act', 'w1', 'focus'], alpha)
    expect([lost.code, lost.stdout, lost.stderr]).toEqual([1, '', 'acdev: acdev runtime closed the connection\n'])
    await crashing.child.exited

    const desktop = start(['--desktop', 'dopame', '--headless'], alpha, { FAKE_ACDERT_DIES_ON: 'close' })
    await until('the session file', () => existsSync(desktop.file))
    const crashed = await desktop.tool(['act', 'w1', 'close'], alpha)
    expect([crashed.code, crashed.stdout, crashed.stderr]).toEqual([1, '', 'acdev: acdev runtime closed the connection\n'])
    await desktop.child.exited

    const stopping = start([], alpha)
    await until('the session file', () => existsSync(stopping.file))
    const began = performance.now()
    const stopped = await stopping.tool(['stop'], alpha)
    expect(performance.now() - began).toBeLessThan(2_000)
    expect(stopped.stdout).toBe(`acdev: stopped acdev dev ${stopping.child.pid}\n`)
    expect(stopped.code).toBe(0)
    expect(await stopping.child.exited).toBe(0)
    expect(existsSync(stopping.file)).toBe(false)
    expect(stopping.entries().some((e) => e.got?.['type'] === 'quit')).toBe(true)
    const none = await stopping.tool(['stop'], alpha)
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('no acdev dev is running')
  }, 30_000)

  test('acdev devtools against a runtime that answers only a port: no token in the list or the address', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { FAKE_ACDERT_DEVTOOLS_TOKENLESS: '1' })
    try {
      await until('the session file', () => existsSync(dev.file))
      const opened = await dev.tool(['devtools', 'alpha'], alpha, undefined, { ACDEV_BROWSER: 'none' })
      expect(opened.code, opened.stderr).toBe(0)
      expect(opened.stdout)
        .toMatch(/^devtools:\/\/devtools\/bundled\/devtools_app\.html\?ws=127\.0\.0\.1%3A\d+%2Fdevtools%2Fpage%2F7\n$/)
      expect(dev.entries().some((e) => (e as { devtools?: string }).devtools === '/json/list')).toBe(true)
    } finally {
      await dev.stop()
    }
  }, 60_000)

  test('acdev devtools starts the browser on its own profile, opens the front end with Target.createTarget, '
    + 'then reuses that browser and brings an open front end to the front', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha)
    const cache = join(base, 'cache')
    const log = join(base, 'browser.log')
    writeFileSync(log, '')
    const browser = fakeBrowser(base)
    const vars = {
      ACDEV_BROWSER: browser, FAKE_BROWSER_LOG: log, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, HOME: base,
      USERPROFILE: base,
    }
    type Said = { started?: string[]; pid?: number; method?: string; params?: { url?: string; targetId?: string } }
    const said = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Said)
    try {
      await until('the session file', () => existsSync(dev.file))
      const first = await dev.tool(['devtools', 'alpha'], alpha, undefined, vars)
      expect(first.code, first.stderr).toBe(0)
      expect(first.stderr).toContain(`acdev: opened DevTools for Alpha in ${browser}`)
      const url = first.stdout.trim()
      expect(url).toStartWith('devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1%3A')
      const started = said().filter((entry) => entry.started)
      expect(started).toHaveLength(1)
      const profile = started[0]!.started!.find((arg) => arg.startsWith('--user-data-dir='))!.slice(16)
      const caches = process.platform === 'darwin' ? join(base, 'Library', 'Caches') : cache
      expect(profile.startsWith(join(caches, 'acdev', 'devtools'))).toBe(true)
      expect(started[0]!.started).toContain('--remote-debugging-port=0')
      expect(started[0]!.started).toContain('--no-startup-window')
      expect(started[0]!.started).toContain('--disable-sync')
      expect(started[0]!.started).not.toContain(url)
      expect(said().filter((entry) => entry.method === 'Target.createTarget').map((entry) => entry.params?.url))
        .toEqual([url])
      const again = await dev.tool(['devtools', 'alpha'], alpha, undefined, vars)
      expect(again.code, again.stderr).toBe(0)
      expect(again.stderr).toContain(`acdev: brought DevTools for Alpha to the front in ${browser}`)
      expect(said().filter((entry) => entry.started)).toHaveLength(1)
      expect(said().filter((entry) => entry.method === 'Target.createTarget')).toHaveLength(1)
      expect(said().filter((entry) => entry.method === 'Target.activateTarget').map((entry) => entry.params))
        .toEqual([{ targetId: 'fake-target-1' }])
      const desk = await dev.tool(['devtools', 'desktop'], alpha, undefined, vars)
      expect(desk.stderr).toContain(`acdev: opened DevTools for Desk in ${browser}`)
      expect(said().filter((entry) => entry.method === 'Target.createTarget')).toHaveLength(2)
      const nowhere = { ...vars, ACDEV_BROWSER: join(base, 'nope') }
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

  test('F12 in a host window: acdev dev opens DevTools on the page acdert names, prints the address when no browser '
    + 'opens it, once per press, and a page with no target only prints why', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { ACDEV_BROWSER: 'none' })
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
    expect(output.split('acdev: DevTools for Alpha: ACDEV_BROWSER=none: no browser opened; paste').length - 1).toBe(2)
    expect(output).toContain('acdev: F12: no DevTools target for gone#3; the targets are:')
  }, 60_000)

  test('F12 with a browser: the first press opens DevTools, the next brings it to the front', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const cache = join(base, 'cache')
    const log = join(base, 'browser.log')
    writeFileSync(log, '')
    const browser = fakeBrowser(base)
    const dev = start([], alpha, {
      ACDEV_BROWSER: browser, FAKE_BROWSER_LOG: log, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, HOME: base, USERPROFILE: base,
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
    expect(output).toContain(`acdev: opened DevTools for Alpha in ${browser}`)
    expect(output).toContain(`acdev: brought DevTools for Alpha to the front in ${browser}`)
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
      const hints = 'alpha waits for approval of camera: acdev allow (or acdev deny)\n' +
        'beta waits for approval of microphone: acdev allow (or acdev deny)\n'
      const webs = await said('webs')
      expect(webs[1]).toContain('alpha#7  app      alpha  7       Alpha\n')
      expect(webs[1]).toEndWith(hints)
      const waiting = '  1  alpha  camera  (request)\n  2  beta  microphone  (request)\n'
      expect(await said('permissions')).toEqual([0, `pending:\n${waiting}decisions: none\n`, ''])
      const several =
        `acdev: 2 approval prompts wait; name one (its id, or <app> <capability>) or pass --all:\n${waiting}`
      expect(await said('allow')).toEqual([1, '', several])
      expect(await said('deny')).toEqual([1, '', several])
      expect(await said('allow', '7')).toEqual([1, '', 'acdev: no approval prompt 7 is waiting (waiting: 1, 2)\n'])
      expect(await said('deny', 'alpha', 'network'))
        .toEqual([1, '', 'acdev: no approval prompt of alpha for network is waiting (waiting: 1, 2)\n'])
      expect(await said('allow', 'alpha')).toEqual([1, '', 'acdev: allow: alpha is not a prompt id ' +
        '(acdev permissions lists them); or give <app> <capability> (acdev allow --help)\n'])
      expect(await said('deny', '1', '--all')).toEqual([1, '',
        'acdev: deny: --all answers every waiting prompt; leave the prompt out (acdev deny --help)\n'])
      expect((await dev.tool(['allow', 'a', 'b', 'c'], alpha)).stderr)
        .toContain('allow: 0 to 2 arguments, not 3 (acdev allow --help)')
      expect(dev.entries().some((e) => e.got?.['op'] === 'answer')).toBe(false)

      expect(await said('allow', 'alpha', 'camera')).toEqual([0, 'allowed alpha camera (prompt 1)\n', ''])
      expect((await dev.tool(['webs'], alpha)).stdout).toEndWith('beta waits for approval of microphone: acdev allow (or acdev deny)\n')
      expect(await said('deny')).toEqual([0, 'denied beta microphone (prompt 2)\n', ''])
      const decided = '  alpha  camera  granted\n  beta  microphone  denied\n'
      expect(await said('permissions')).toEqual([0, `pending: none\ndecisions:\n${decided}`, ''])
      expect(await said('allow')).toEqual([1, '', 'acdev: no approval prompt is waiting\n'])
      expect(await said('deny', '--all')).toEqual([1, '', 'acdev: no approval prompt is waiting\n'])
      expect(await said('allow', 'beta', 'microphone')).toEqual([1, '', 'acdev: no approval prompt of beta for ' +
        'microphone is waiting: it is already denied (revoke takes that back)\n'])
      expect(await said('revoke', 'beta', 'microphone')).toEqual([0, 'revoked beta microphone\n', ''])
      expect(await said('revoke', 'beta', 'microphone')).toEqual([1, '',
        'acdev: no decision about beta microphone to revoke (permissions lists the decisions)\n'])
      expect((await dev.tool(['revoke', 'beta'], alpha)).stderr)
        .toContain('revoke: 2 arguments, not 1 (acdev revoke --help)')
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

  test('a runtime of another contract level: acdev dev stops before starting it', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    for (const [level, runtime] of [[String(API_LEVEL + 1), API_LEVEL + 1], ['none', 0]] as const) {
      const dev = start([], alpha, { FAKE_ACDERT_LEVEL: level })
      expect(await dev.child.exited).toBe(1)
      expect(await dev.output).toContain(`alpha: needs level ${API_LEVEL}, runtime is level ${runtime}`)
      expect(dev.entries().filter((e) => e.argv)).toEqual([])
    }
  }, 30_000)

  test('acdev eval while acdev dev rebuilds and reloads again and again finds the one session every time', async () => {
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
            expect(ran.stderr).not.toContain('acdev dev sessions runs')
            expect(ran.stderr).not.toContain('no acdev dev is running')
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
        + `give a directory as the first argument: acdev dev ${a}`],
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
