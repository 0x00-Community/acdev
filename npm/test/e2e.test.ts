import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Color } from '../src/color.ts'
import { Acde } from '../src/driver/acde.ts'
import { TestRunner } from '../src/e2e/runner.ts'
import { E2e } from '../src/e2e/settings.ts'
import { TestTsconfig } from '../src/e2e/tsconfig.ts'
import { Png } from '../src/driver/png.ts'
import { cleanup, standIn } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const BROKEN = join('e2e', 'broken.e2e.ts')
const TASKS = join('e2e', 'tasks.e2e.ts')

afterAll(cleanup)

const PASSING = `import { test, expect } from 'acdev/test'

test('adds a task', async ({ app, home }) => {
  expect(home).toContain('acde-test-')
  await app!.getByRole('textbox', { name: 'New task' }).fill('Buy milk')
  await app!.getByRole('button', { name: 'Add' }).click()
  await expect(app!.getByRole('listitem')).toHaveCount(1)
  expect((await app!.console()).entries.map((e) => e.text)).toEqual(['alpha ready', 'added Buy milk'])
})

test('starts empty again', async ({ app }) => {
  await expect(app!.getByRole('listitem')).toHaveCount(0)
})
`

const FAILING = `import { test, expect } from 'acdev/test'
import { Acde } from 'acdev/driver'

test('looks for what is not there', async ({ app }) => {
  await expect(app!.getByText('Nowhere')).toBeVisible({ timeout: 200 })
})

test('fine', async ({ acde }) => {
  expect(acde).toBeInstanceOf(Acde)
  expect(acde.session.test).toBe(true)
  expect((await acde.webs()).length).toBe(2)
})
`

function project() {
  const s = standIn()
  mkdirSync(join(s.project, 'e2e'))
  writeFileSync(join(s.project, 'e2e/tasks.e2e.ts'), PASSING)
  writeFileSync(join(s.project, 'e2e/broken.e2e.ts'), FAILING)
  const unit = "import { test } from 'bun:test'\n" +
    "test('not e2e', () => { throw new Error('acdev test ran a unit test') })\n"
  writeFileSync(join(s.project, 'unit.test.ts'), unit)
  return s
}

interface Started {
  readonly argv?: string[]
  readonly headless?: string | null
  readonly env?: Record<string, string | null>
}

async function acdeTest(s: ReturnType<typeof standIn>, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, CLI, 'test', ...args], {
    cwd: s.project, env: { ...s.env, ...env }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  const started = readFileSync(s.env['FAKE_ACDERT_LOG']!, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Started)
    .filter((e) => e.argv)
  return { code, out: stdout + stderr, started }
}

describe('acdev test', () => {
  const every = 'runs every *.e2e.ts in its own bun test; a fresh isolated headless acdev dev per test; ' +
    'a failure leaves what it saw'
  test(every, async () => {
    const s = project()
    const run = await acdeTest(s, [])
    expect(run.code).toBe(1)
    expect(run.out).toContain(`acdev test: ${BROKEN}\n`)
    expect(run.out).toContain(`acdev test: ${TASKS}\n`)
    expect(run.out).toContain(`acdev test: 4 tests in 2 files: 3 passed, 1 failed; failed: ${BROKEN}`)
    expect(run.out).not.toContain('acdev test ran a unit test')
    expect(run.out)
      .toContain('expected window(app "alpha").getByText("Nowhere") to be visible within 200 ms; saw no element')
    expect(run.started.length).toBe(4)
    for (const started of run.started) {
      expect(started.headless).toBe('1')
      expect(started.env).toMatchObject({
        ACDE_STORAGE: '', ACDE_SIZE: E2e.SIZE, ACDE_COLOR_SCHEME: 'light',
        ACDE_AUTOSTART: '0', ACDEV_TEST_SESSION: null,
      })
      expect(started.env!['XDG_CONFIG_HOME']).toMatch(/acde-test-[^/\\]+[/\\]config$/)
      expect(started.env!['HOME']).toMatch(/acde-test-[^/\\]+[/\\]home$/)
    }
    expect(new Set(run.started.map((e) => e.env!['XDG_CONFIG_HOME'])).size).toBe(4)
    expect(run.started[0]!.argv).toEqual(['app', 'alpha'])
    const left = join(s.project, '.acde/test-results/e2e-broken/looks-for-what-is-not-there')
    const saved = 'error.txt, output.log, screen.png, snapshot.txt, console.txt, network.txt, trace.txt'
    expect(run.out).toContain(`acdev test: saved ${saved} in ${left}`)
    expect(readdirSync(left).sort())
      .toEqual(['console.txt', 'error.txt', 'network.txt', 'output.log', 'screen.png', 'snapshot.txt', 'trace.txt'])
    const step = /^ {2}1 FAIL \+\d+\.\d\ds +\d+ ms {2}/
    const trace = readFileSync(join(left, 'trace.txt'), 'utf8')
    expect(trace).toMatch(step)
    expect(trace.replace(step, '')).toStartWith('expect window(app "alpha").getByText("Nowhere") to be visible\n')
    expect(readFileSync(join(left, 'error.txt'), 'utf8'))
      .toContain('AssertionError: expected window(app "alpha").getByText("Nowhere")')
    expect(readFileSync(join(left, 'console.txt'), 'utf8')).toBe('   1 log    alpha#7  alpha ready\n')
    expect(readFileSync(join(left, 'screen.png')).subarray(1, 4).toString()).toBe('PNG')
    expect(existsSync(join(s.project, '.acde/test-results/e2e-tasks'))).toBe(false)
    expect(existsSync(join(s.project, '.acde/test/web'))).toBe(true)
  }, 120_000)

  test('--headed, -t, a file, --bail; mistakes are explained', async () => {
    const s = project()
    const one = await acdeTest(s, [TASKS, '--headed', '-t', 'adds'])
    expect(one.code).toBe(0)
    expect(one.out).toContain(`acdev test: ${TASKS} (headed)`)
    const selected = 'acdev test: 1 test in 1 file: 1 passed, 0 failed, 1 not run (skipped, todo, or not matched by -t)'
    expect(one.out).toContain(`${selected}\n`)
    expect(one.started.map((e) => e.headless)).toEqual([null])
    const bail = await acdeTest(s, ['--bail'])
    expect(bail.out)
      .toContain(`acdev test: 1 test in 1 file: 0 passed, 1 failed; failed: ${BROKEN}; 1 file not run (--bail)`)
    writeFileSync(join(s.project, 'e2e/unloadable.e2e.ts'), "import { test } from 'acdev/test'\nthrow new Error('no')\n")
    const unloadable = await acdeTest(s, [TASKS, join('e2e', 'unloadable.e2e.ts')])
    const unloaded = join('e2e', 'unloadable.e2e.ts')
    expect(unloadable.out).toContain(`acdev test: 2 tests in 1 file: 2 passed, 0 failed; failed: ${unloaded}; ` +
      'not counted: ' +
      `${unloaded} (bun test left no report: the file did not load, or its run was killed)\n`)
    rmSync(join(s.project, 'e2e/unloadable.e2e.ts'))
    expect((await acdeTest(s, ['unit.test.ts'])).out).toContain('unit.test.ts: an e2e test file is named *.e2e.ts')
    expect((await acdeTest(s, ['nope'])).out).toContain('acdev: nope: no such file or directory')
    mkdirSync(join(s.root, 'empty'))
    writeFileSync(join(s.root, 'empty/acde.config.jsonc'), '{"type":"app","id":"empty"}')
    const empty = await acdeTest(s, [join(s.root, 'empty')])
    expect(empty.code).toBe(0)
    expect(empty.out).toContain('acdev test: no e2e tests (**/*.e2e.{ts,tsx,js,mjs,mts})')
    expect(empty.out).toContain('acdev test: write one as e2e/app.e2e.ts')
    expect((await acdeTest(s, ['--timeout', 'soon'])).out).toContain('acdev: test: --timeout soon: ')
  }, 120_000)

  test('-t skips the files where it matches no test; a filter that matches nothing anywhere fails', async () => {
    const s = project()
    const some = await acdeTest(s, ['-t', 'adds'])
    expect(some.out).toContain(`acdev test: ${BROKEN}: no test matches -t "adds", skipped`)
    expect(some.out).toContain('acdev test: 1 test in 1 file: 1 passed, 0 failed, 1 not run (skipped, todo, or not ' +
      'matched by -t); 1 file skipped (no test matches -t)')
    expect(some.code).toBe(0)
    expect(some.started.length).toBe(1)
    const none = await acdeTest(s, ['-t', 'nothing at all'])
    expect(none.out).toContain('acdev test: no test matches -t "nothing at all" in 2 files')
    expect(none.out).not.toContain('ran:')
    expect(none.code).toBe(1)
  }, 120_000)

  const late = 'a test that runs out of time, even the last of its file, leaves what it saw; ' +
    'one whose acdev dev never starts leaves the reason'
  test(late, async () => {
    const s = standIn()
    mkdirSync(join(s.project, 'e2e'))
    const file = join('e2e', 'slow.e2e.ts')
    writeFileSync(join(s.project, file), `import { test, expect } from 'acdev/test'

test('quick', async ({ app }) => {
  await expect(app!.getByRole('listitem')).toHaveCount(0)
})

test('never ends', async ({ app }) => {
  await expect(app!.getByText('Nowhere')).toBeVisible({ timeout: 600000 })
})
`)
    const slow = await acdeTest(s, ['--timeout', '4000'])
    expect(slow.code).toBe(1)
    const left = join(s.project, '.acde/test-results/e2e-slow/never-ends')
    const why = 'TimeoutError: the test did not finish within 4000 ms ' +
      '(its timeout: --timeout, or the one given to test())'
    expect(slow.out).toContain(why)
    const saved = 'error.txt, output.log, screen.png, snapshot.txt, console.txt, network.txt, trace.txt'
    expect(slow.out).toContain(`acdev test: saved ${saved} in ${left}`)
    expect(slow.out).toContain(`acdev test: 2 tests in 1 file: 1 passed, 1 failed; failed: ${file}\n`)
    expect(slow.out).not.toContain('dangling process')
    expect(readdirSync(left).sort())
      .toEqual(['console.txt', 'error.txt', 'network.txt', 'output.log', 'screen.png', 'snapshot.txt', 'trace.txt'])
    expect(readFileSync(join(left, 'error.txt'), 'utf8')).toStartWith(why)
    expect(readFileSync(join(left, 'output.log'), 'utf8')).toContain('acdev: dev app alpha (headless)')
    expect(readdirSync(join(s.root, 'acde-dev'))).toEqual([])

    const stuck = await acdeTest(s, ['--timeout', '3000', '-t', 'quick'], { FAKE_ACDERT_LISTEN_MS: '600000' })
    expect(stuck.code).toBe(1)
    const unstarted = join(s.project, '.acde/test-results/e2e-slow/quick')
    expect(stuck.out).toMatch(/acdev dev \(pid \d+\) did not register a session within 2 s in /)
    expect(stuck.out)
      .toContain('\nno session yet: its build did not finish, or acdev runtime did not start listening; last output:\n')
    expect(stuck.out).toContain(`acdev test: saved error.txt, output.log in ${unstarted}`)
    expect(readdirSync(unstarted).sort()).toEqual(['error.txt', 'output.log'])
    expect(readFileSync(join(unstarted, 'error.txt'), 'utf8')).toContain('acdev: dev app alpha (headless)')
    const output = readFileSync(join(unstarted, 'output.log'), 'utf8').split('\n')
    expect(output[0]).toStartWith('acdev: dev app alpha (headless): ')
    expect(output).toContain('12.345 I acde js: fake acdert is up')
    expect(readdirSync(join(s.root, 'acde-dev')).filter((name) => name.endsWith('.json'))).toEqual([])

    const windowless = await acdeTest(s, ['--timeout', '3000', '-t', 'quick'], { FAKE_ACDERT_WINDOWLESS: '1' })
    expect(windowless.code).toBe(1)
    expect(windowless.out).toContain('acdev dev did not start within 2 s:\nacdev runtime runs and answers, but no ' +
      'window appeared (pages: 0, windows: 0) and no approval prompt waits; last output:\n')
    expect(readdirSync(unstarted).sort()).toEqual(['error.txt', 'output.log'])

    writeFileSync(join(s.project, 'acde.config.jsonc'), '{ "type": "app" ')
    const broken = await acdeTest(s, ['--timeout', '3000', '-t', 'quick'])
    expect(broken.code).toBe(1)
    expect(broken.out).toContain('acdev dev exited (1) before it was ready:\n')
    expect(broken.out).toContain(`acdev test: saved error.txt, output.log in ${unstarted}`)
    expect(readFileSync(join(unstarted, 'output.log'), 'utf8')).toStartWith('acdev: ')
  }, 120_000)

  const ci = 'in CI (CI set) the tests run, and a missing screenshot baseline is an error instead of being written'
  test(ci, async () => {
    const s = project()
    const run = await acdeTest(s, [TASKS], { CI: '1' })
    expect(run.out).toContain('acdev test: 2 tests in 1 file: 2 passed, 0 failed')
    expect(run.code).toBe(0)
    writeFileSync(join(s.project, 'e2e/look.e2e.ts'), `import { test, expect } from 'acdev/test'
test('looks', async ({ app }) => {
  await expect(app!).toHaveScreenshot({ timeout: 1000 })
})
`)
    const missing = await acdeTest(s, ['e2e/look.e2e.ts'], { CI: '1' })
    expect(missing.code).toBe(1)
    expect(existsSync(join(s.project, 'e2e/__screenshots__'))).toBe(false)
  }, 120_000)

  const screenshots = 'screenshot baselines: written next to the test the first time, compared after, ' +
    'rewritten with -u; --trace keeps every step'
  test(screenshots, async () => {
    const s = standIn()
    mkdirSync(join(s.project, 'e2e'))
    const file = join(s.project, 'e2e/look.e2e.ts')
    const write = (tasks: number) =>
      writeFileSync(file, `import { test, expect } from 'acdev/test'

test('the empty list', async ({ app }) => {
  for (const name of ${JSON.stringify(Array.from({ length: tasks }, (_, i) => `task ${i}`))}) {
    await app!.getByRole('textbox', { name: 'New task' }).fill(name)
    await app!.getByRole('button', { name: 'Add' }).click()
  }
  await expect(app!.getByRole('listitem')).toHaveCount(${tasks})
  await expect(app!).toHaveScreenshot({ timeout: 1000 })
  await expect(app!.getByRole('textbox', { name: 'New task' })).toHaveScreenshot('field')
})
`)
    write(0)
    const baselines = join(s.project, 'e2e/__screenshots__/look.e2e.ts')
    const first = await acdeTest(s, [])
    expect(first.code).toBe(0)
    expect(readdirSync(baselines).sort())
      .toEqual([`field-${process.platform}.png`, `the-empty-list-1-${process.platform}.png`])
    const baseline = join(baselines, `the-empty-list-1-${process.platform}.png`)
    expect(first.out).toContain(`acdev: wrote screenshot ${baseline}`)
    expect(Png.decode(readFileSync(join(baselines, `field-${process.platform}.png`))).width).toBe(4)
    expect((await acdeTest(s, [])).code).toBe(0)

    write(2)
    const changed = await acdeTest(s, [])
    expect(changed.code).toBe(1)
    expect(changed.out).toContain(`to match screenshot ${baseline}: 2 pixels differ`)
    const left = join(s.project, '.acde/test-results/e2e-look/the-empty-list')
    expect(readdirSync(left)).toEqual(expect.arrayContaining([
      'the-empty-list-1-actual.png', 'the-empty-list-1-diff.png', 'the-empty-list-1-expected.png', 'trace.txt',
    ]))

    const updated = await acdeTest(s, ['-u', '--trace'])
    expect(updated.code).toBe(0)
    expect(updated.out).toContain(`acdev: updated screenshot ${baseline}`)
    expect(updated.out).toContain(`acdev test: trace of "the empty list": ${join(left, 'trace.txt')}`)
    expect(readdirSync(left).sort()).toEqual(['trace', 'trace.html', 'trace.txt'])
    expect(readFileSync(join(left, 'trace.html'), 'utf8'))
      .toContain('expect window(app &quot;alpha&quot;) to match screenshot the-empty-list-1')
    expect(readdirSync(join(left, 'trace')).length).toBeGreaterThan(5)
    expect((await acdeTest(s, [])).code).toBe(0)
    expect(existsSync(left)).toBe(false)
  }, 120_000)
})

describe('acdev test in a project managed by npm', () => {
  const runtime = 'the driver starts acdev dev on the runtime of the project itself, ' +
    'so the dev session is the process it waits for'
  test(runtime, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'acde-runtime-')))
    const at = (name: string, lock: string) => {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, lock), '{}')
      return join(root, name)
    }
    const npm = at('npm', 'package-lock.json')
    const bun = at('bun', 'bun.lock')
    const found = () => ({ bun: '/opt/bun', node: '/opt/node' })
    const bundled = join(root, 'dist', 'cli.js')
    expect(Acde.runtime(npm, bundled, found)).toBe('/opt/node')
    expect(Acde.runtime(bun, bundled, found)).toBe(process.execPath)
    expect(Acde.runtime(npm, bundled, () => ({ bun: '/opt/bun', node: null }))).toBe(process.execPath)
    expect(Acde.runtime(npm, join(root, 'src', 'cli.ts'), found)).toBe(process.execPath)
  })

  test('its e2e tests run and pass', async () => {
    const s = project()
    writeFileSync(join(s.project, 'package-lock.json'), JSON.stringify({ name: 'alpha', lockfileVersion: 3 }))
    const run = await acdeTest(s, [TASKS])
    expect(run.out).toContain('acdev test: 2 tests in 1 file: 2 passed, 0 failed')
    expect(run.code).toBe(0)
  }, 120_000)
})

interface Built {
  readonly compilerOptions: { paths: Record<string, string[]> }
}

describe('the count of tests comes from the JUnit report bun test writes', () => {
  test('ran, passed and failed from the root element; no report, or one that does not add up, is no count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acde-test-'))
    const report = join(dir, 'report.xml')
    const xml = (attributes: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" ` +
      `${attributes} time="0.05">\n  <testsuite name="a.e2e.ts" tests="99" failures="99" skipped="0">\n  ` +
      '</testsuite>\n</testsuites>\n'
    writeFileSync(report, xml('tests="5" assertions="2" failures="2" skipped="2"'))
    expect(TestRunner.tally(report)).toEqual({ ran: 3, passed: 1, failed: 2, skipped: 2 })
    writeFileSync(report, xml('tests="2" failures="3" skipped="0"'))
    expect(TestRunner.tally(report)).toBeNull()
    writeFileSync(report, xml('tests="two" failures="0" skipped="0"'))
    expect(TestRunner.tally(report)).toBeNull()
    writeFileSync(report, '')
    expect(TestRunner.tally(report)).toBeNull()
    expect(TestRunner.tally(join(dir, 'none.xml'))).toBeNull()
    const one = { ran: 1, passed: 1, failed: 0, skipped: 0 }
    const run = { tallies: [one], uncounted: [], failed: [], files: 1, filtered: 0, unrun: 0 }
    expect(TestRunner.summary(run)).toBe('acdev test: 1 test in 1 file: 1 passed, 0 failed')
    const two = { ...run, tallies: [one, { ran: 3, passed: 1, failed: 2, skipped: 2 }], failed: ['b.e2e.ts'], files: 2 }
    expect(TestRunner.summary(two)).toBe('acdev test: 4 tests in 2 files: 2 passed, 2 failed, 2 not run (skipped, todo, '
      + 'or not matched by -t); failed: b.e2e.ts')
    const both = ['a.e2e.ts', 'b.e2e.ts']
    const lost = { ...run, tallies: [], uncounted: both, failed: both, files: 2 }
    expect(TestRunner.summary(lost)).toBe('acdev test: 2 files ran; failed: a.e2e.ts, b.e2e.ts; not counted: a.e2e.ts, '
      + 'b.e2e.ts (bun test left no report: the file did not load, or its run was killed)')
    expect(TestRunner.summary({ ...two, unrun: 1, filtered: 2 }, Color.palette(true)))
      .toStartWith('\x1b[1;31macdev test:\x1b[22;39m 4 tests')
  })
})

describe('TestTsconfig', () => {
  const resolves = 'acdev/test and acdev/driver resolve to this acdev; the project\'s own paths stay, ' +
    'through extends chains (relative, array, package) and JSONC'
  test(resolves, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'acde-tsconfig-')))
    const at = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    at('node_modules/@acme/tsconfig/package.json', '{"name":"@acme/tsconfig"}')
    at('node_modules/@acme/tsconfig/tsconfig.json', '{"compilerOptions":{"paths":{"#lib/*":["./lib/*"]}}}')
    at('base.json', '{\n  // shared\n  "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["./*"], }, },\n}')
    at('other.json', '{"compilerOptions":{"paths":{"other":["./other.ts"]}}}')
    at('app/tsconfig.json', '{"extends":["../other.json","../base"]}')
    at('app/acde.config.jsonc', '{}')
    at('pkg/tsconfig.json', '{"extends":"@acme/tsconfig"}')
    at('lone/acde.config.jsonc', '{}')
    const app = TestTsconfig.build(join(root, 'app')) as Built & { extends: string }
    expect(app.extends).toBe(join(root, 'app/tsconfig.json'))
    expect(app.compilerOptions.paths['@/*']).toEqual([join(root, 'src/*')])
    expect(app.compilerOptions.paths['other']).toBeUndefined()
    expect(app.compilerOptions.paths['acdev/test']).toEqual([TestTsconfig.MODULES['acdev/test']!])
    expect(app.compilerOptions.paths['acdev/driver']).toEqual([join(import.meta.dir, '../src/driver/index.ts')])
    expect(TestTsconfig.paths(join(root, 'pkg/tsconfig.json')))
      .toEqual({ '#lib/*': [join(root, 'node_modules/@acme/tsconfig/lib/*')] })
    const lone = TestTsconfig.build(join(root, 'lone')) as Built & { extends?: string }
    expect(lone.extends).toBeUndefined()
    expect(Object.keys(lone.compilerOptions.paths).sort()).toEqual(['acdev/driver', 'acdev/test'])
  })
})

describe('failures name the test file, not acde', () => {
  test('frames inside acde (its dist or src) and native frames leave the stack; the message stays', async () => {
    const { E2eRun } = await import('../src/e2e/index.ts')
    const root = join(tmpdir(), 'acde-root')
    const error = new Error('expected a thing')
    error.stack = [
      'AssertionError: expected a thing',
      `      at ${join(root, 'dist', 'chunk-3ggedqd6.js')}:1:129473`,
      `      at ${join(root, 'src', 'driver', 'expect.ts')}:10:3`,
      '      at C:\work\calculator\e2e\calculator.e2e.ts:9:42',
      '      at processTicksAndRejections (native:7:39)',
      '      at emit (node:events:100:22)',
      '      at addChunk (internal:streams/readable:267:47)',
    ].join('\n')
    E2eRun.ownFrames(error, root)
    expect(error.stack).toBe('AssertionError: expected a thing\n      at C:\work\calculator\e2e\calculator.e2e.ts:9:42')
    const inside = new Error('only acde frames')
    inside.stack = `Error: only acde frames\n      at ${join(root, 'dist', 'cli.js')}:1:1`
    E2eRun.ownFrames(inside, root)
    expect(inside.stack).toContain('cli.js')
  })
})

describe('acdev test --vm needs no acde project on the host', () => {
  test('a test file outside any project runs with --vm and is refused without it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acde-vm-suites-'))
    try {
      mkdirSync(join(dir, 'e2e'))
      writeFileSync(join(dir, 'e2e', '01-lock.e2e.ts'), '')
      writeFileSync(join(dir, 'e2e', '02-files.e2e.ts'), '')
      expect(() => TestRunner.suites(['e2e/01-lock.e2e.ts'], dir)).toThrow('no acde project (acde.config.jsonc) holds it')
      expect(TestRunner.suites(['e2e/01-lock.e2e.ts'], dir, true)).toEqual([
        { file: join(dir, 'e2e', '01-lock.e2e.ts'), project: join(dir, 'e2e') },
      ])
      expect(TestRunner.suites(['e2e'], dir, true).map((s) => [s.file, s.project])).toEqual([
        [join(dir, 'e2e', '01-lock.e2e.ts'), join(dir, 'e2e')],
        [join(dir, 'e2e', '02-files.e2e.ts'), join(dir, 'e2e')],
      ])
      writeFileSync(join(dir, 'acde.config.jsonc'), '{}')
      expect(TestRunner.suites(['e2e/01-lock.e2e.ts'], dir, true)[0]!.project).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

