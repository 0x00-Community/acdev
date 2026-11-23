import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { API_LEVEL } from '../../src/manifest/index.ts'
import { DevSession } from '../../src/dev.ts'
import { Devtools } from '../../src/devtools.ts'
import type { Session } from '../../src/sessions.ts'
import { cleanup, tmp, until, WINDOWS } from '../helpers.ts'
import { project, start } from './standin.ts'

afterAll(cleanup)

describe('acdev dev with a stand-in acdert', () => {
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
      const noBrowser = { ACDEV_BROWSER: 'none' }
      const focused = await dev.tool(['devtools'], alpha, undefined, noBrowser)
      expect(focused.code, focused.stderr).toBe(0)
      expect(focused.stdout).toMatch(frontend(7))
      expect(focused.stderr).toContain('acdev: DevTools for Alpha: ACDEV_BROWSER=none: no browser opened; paste')
      const desk = await dev.tool(['devtools', 'desktop'], alpha, undefined, noBrowser)
      expect(desk.code, desk.stderr).toBe(0)
      expect(desk.stdout).toMatch(frontend(0))
      expect((await dev.tool(['devtools', 'alpha'], alpha, undefined, noBrowser)).stdout).toMatch(frontend(7))
      const nowhere = await dev.tool(['devtools', 'nope'], alpha, undefined, noBrowser)
      expect(nowhere.code).toBe(1)
      expect(nowhere.stderr).toContain('acdev: no DevTools target for nope; the targets are:\n  0  page  Desk\n')
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
      expect(failed.stderr).toContain('acdev: no web "nope"')
      const shot = await dev.tool(['shot', 'alpha#7'], base)
      expect(shot.stdout.trim()).toBe(join(realpathSync(base), 'alpha#7.png'))
      expect(readFileSync(join(base, 'alpha#7.png')).subarray(1, 4).toString()).toBe('PNG')
      const named = await dev.tool(['shot', 'desktop', '-o', join(base, 'd.png')], alpha)
      expect(named.stdout.trim()).toBe(join(base, 'd.png'))
      const inspected = await dev.tool(['inspect', '--find', 'add', '--window', 'w1', '--all'], alpha)
      expect(inspected.stdout).toBe('w1 alpha "Alpha":\n- button "Add" [disabled] [w1.3]\n')
      const missing = await dev.tool(['inspect', '--find', 'Save'], alpha)
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain('acdev: no element\'s name or value contains "Save"; ')
      expect((await dev.tool(['inspect'], alpha)).stdout).toBe('snapshot {"window":null,"find":null,"all":false}\n')
      expect((await dev.tool(['act', 'w1.5', 'type', 'hello world'], alpha)).stdout).toBe('type w1.5 "hello world"\n')
      expect((await dev.tool(['act', 'w1.5', 'fail'], alpha)).code).toBe(1)
      const unknown = await dev.tool(['act', 'w1.404', 'click'], alpha)
      expect([unknown.code, unknown.stdout]).toEqual([1, ''])
      expect(unknown.stderr).toBe('acdev: act w1.404: there is no such element (any more); '
        + 'acdev inspect --find TEXT gives the current refs\n')
      const windows = 'the windows: w0 desktop, w1 "Alpha" (acdev inspect lists them)'
      const noWindow = await dev.tool(['inspect', '--window', 'w9'], alpha)
      expect([noWindow.code, noWindow.stderr]).toEqual([1, `acdev: no window w9; ${windows}\n`])
      const noQuery = await dev.tool(['query', 'h1', '--window', 'w9'], alpha)
      expect([noQuery.code, noQuery.stderr]).toEqual([1, `acdev: no window w9; ${windows}\n`])
      const away = await dev.tool(['act', 'w9.1', 'click'], alpha)
      expect([away.code, away.stderr]).toEqual([1, `acdev: act w9.1: no window w9; ${windows}\n`])
      const untyped = await dev.tool(['act', 'w1.5', 'type'], alpha)
      expect([untyped.code, untyped.stderr])
        .toEqual([1, 'acdev: act: type needs the text to type: acdev act w1.5 type "hello"\n'])
      expect((await dev.tool(['webs', '--session', String(dev.child.pid)], dev.root)).code).toBe(0)
      expect((await dev.tool(['inspect', '--offscreen'], alpha)).code).toBe(0)
      const logged = await dev.tool(['console'], alpha)
      expect(logged.stdout).toBe('   1 log    alpha#7  alpha ready\n')
      expect((await dev.tool(['console', '--level', 'loud'], alpha)).stderr).toContain('--level loud: one of')
      const noRequests = await dev.tool(['network', '--failed'], alpha)
      expect(noRequests.stdout).toBe('')
      expect(noRequests.stderr).toBe('acdev: no requests\n')
      expect(noRequests.code).toBe(0)
      const queried = await dev.tool(['query', '[data-testid="add"]', '--window', 'w1'], alpha)
      expect(queried.stdout).toBe('1 in w1:\n- button "Add" [disabled] [w1.3] <button>\n')
      expect(queried.code).toBe(0)
      expect((await dev.tool(['query', '.ghost', '--window=w1'], alpha)).stdout)
        .toBe('1 in w1:\n- generic [w1.99] <div> [hidden]\n')
      const nothing = await dev.tool(['query', 'nav'], alpha)
      expect([nothing.code, nothing.stdout, nothing.stderr]).toEqual([2, '', 'acdev: nothing in w1 matches "nav"\n'])
      expect((await dev.tool(['query', '*', '--ref', 'w1.4', '--limit', '5'], alpha)).stderr)
        .toBe('acdev: nothing in w1 matches "*"\n')
      expect(dev.entries().findLast((e) => e.got?.['op'] === 'query')?.got)
        .toMatchObject({ selector: '*', ref: 'w1.4', limit: 5 })
      for (const limit of ['0', '3001', 'few']) {
        const refused = await dev.tool(['query', 'li', '--limit', limit], alpha)
        expect([refused.code, refused.stderr]).toEqual([1,
          `acdev: query: --limit ${limit}: how many elements to list at most, 1 to 3000 (acdev query --help)\n`])
      }
      expect((await dev.tool(['query'], alpha)).stderr).toContain('query: 1 arguments, not 0 (acdev query --help)')
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
      expect(quiet.stderr).toBe('acdev: no console entries in that range\n')
      expect((await dev.tool(['console', '--since', '1'], alpha)).stdout).toBe('   1 log    alpha#7  alpha ready\n')
      const wrong = await dev.tool(['network', '--since', 'later'], alpha)
      expect(wrong.code).toBe(1)
      expect(wrong.stderr).toContain('network: --since later: reload, the number of an entry, or the next a merged answer printed')
    } finally {
      await dev.stop()
    }
    expect(await dev.child.exited).toBe(0)
    expect(readdirSync(dev.sessions)).toEqual([])
    expect(readdirSync(dev.root).filter((f) => f.endsWith('.sock'))).toEqual([])
    expect((await dev.tool(['webs'], base)).stderr).toContain('no acdev dev is running')
    const gone = await dev.tool(['devtools'], base, undefined, { ACDEV_BROWSER: 'none' })
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('no acdev dev is running')
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
        apps: [{ id: 'hand', label: 'Hand', icon: 'application-x-executable', entry: '/app/hand/index.html' }],
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

  test('a window session whose first build fails waits for a change, then starts', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha', entry: 'main.html' })
    const dev = start([], alpha)
    try {
      await Bun.sleep(1_500)
      expect(dev.entries().filter((e) => e.argv)).toEqual([])
      expect(dev.child.exitCode).toBeNull()
      writeFileSync(join(alpha, 'main.html'), '<!doctype html><title>x</title><p>x</p>')
      await until('the runtime', () => dev.entries().find((e) => e.argv))
      await until('the session file', () => existsSync(dev.file))
    } finally {
      await dev.stop()
    }
    expect(await dev.output).toContain('acdev: waiting for a change to build again')
  }, 60_000)

  test('a window session outlives a runtime crash: acdev dev starts acdev runtime again; headless ones end', async () => {
    const base = tmp()
    const alpha = project(join(base, 'alpha'), { type: 'app', id: 'alpha' })
    const dev = start([], alpha, { FAKE_ACDERT_DIES_ON: 'focus' })
    try {
      await until('the session file', () => existsSync(dev.file))
      const lost = await dev.tool(['act', 'w1', 'focus'], alpha)
      expect(lost.stderr).toBe('acdev: acdev runtime closed the connection\n')
      await until('the second runtime', () => dev.entries().filter((e) => e.argv).length >= 2)
      await until('its hello', () => dev.entries().filter((e) => e.got?.['type'] === 'hello').length >= 2)
      expect((await dev.tool(['webs'], alpha)).code).toBe(0)
    } finally {
      await dev.stop()
    }
    expect(await dev.output).toContain('acdev: acdev runtime exited (1); starting it again')
  }, 60_000)

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
      '123.456 I acde-child-out acde::host::child: [app#backend] hi',
      '123.457 I acde-child-out acde::host::backends: [app#backend] hi',
      '38.157 I acde acde_host: [withapi#backend] started (pid 5135, port 3000)',
      '15489.032 I acde acde_host: [withapi#1048576] acdev dev: state restored (0 kept)',
      '16153.128 I acde acde_host: [ledger#1048576] alert: hi',
      '21.000 I acde acde_host: Ledger (ledger) waits for the user to allow "camera" (prompt 1; answer it with acdev allow '
        + 'or acdev deny, the acdev driver, or acde:permissions)',
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
      '15442.335 I acde-dev-conn acde_hostwin::dev: acdev dev: reload withapi',
      '95.000 I acde acde::host::backends: removed /tmp/b/app, left by a runtime that is gone',
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
      '14.387 I acde-child-out acde::host::child: [alpha#backend] fake backend output',
      '14.388 I acde-child-out acde::host::backends: [alpha#backend] fake channel backend output',
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
})
