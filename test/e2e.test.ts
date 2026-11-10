import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Acde } from '../src/driver/acde.ts'
import { E2e } from '../src/e2e/settings.ts'
import { TestTsconfig } from '../src/e2e/tsconfig.ts'
import { Png } from '../src/driver/png.ts'
import { cleanup, standIn } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const BROKEN = join('e2e', 'broken.e2e.ts')
const TASKS = join('e2e', 'tasks.e2e.ts')

afterAll(cleanup)

const PASSING = `import { test, expect } from 'acde/test'

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

const FAILING = `import { test, expect } from 'acde/test'
import { Acde } from 'acde/driver'

test('looks for what is not there', async ({ app }) => {
  await expect(app!.getByText('Nowhere')).toBeVisible({ timeout: 200 })
})

test('fine', async ({ acde }) => {
  expect(acde).toBeInstanceOf(Acde)
  expect((await acde.webs()).length).toBe(2)
})
`

function project() {
  const s = standIn()
  mkdirSync(join(s.project, 'e2e'))
  writeFileSync(join(s.project, 'e2e/tasks.e2e.ts'), PASSING)
  writeFileSync(join(s.project, 'e2e/broken.e2e.ts'), FAILING)
  const unit = "import { test } from 'bun:test'\n" +
    "test('not e2e', () => { throw new Error('acde test ran a unit test') })\n"
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

describe('acde test', () => {
  const every = 'runs every *.e2e.ts in its own bun test; a fresh isolated headless acde dev per test; ' +
    'a failure leaves what it saw'
  test(every, async () => {
    const s = project()
    const run = await acdeTest(s, [])
    expect(run.code).toBe(1)
    expect(run.out).toContain(`acde test: ${BROKEN}\n`)
    expect(run.out).toContain(`acde test: ${TASKS}\n`)
    expect(run.out).toContain(`acde test: 2 files, 1 passed, 1 failed: ${BROKEN}`)
    expect(run.out).not.toContain('acde test ran a unit test')
    expect(run.out)
      .toContain('expected window(app "alpha").getByText("Nowhere") to be visible within 200 ms; saw no element')
    expect(run.started.length).toBe(4)
    for (const started of run.started) {
      expect(started.headless).toBe('1')
      expect(started.env).toMatchObject({
        ACDE_STORAGE: '', ACDE_SIZE: E2e.SIZE, ACDE_COLOR_SCHEME: 'light', ACDE_REDUCED_MOTION: '1',
        ACDE_AUTOSTART: '0',
      })
      expect(started.env!['XDG_CONFIG_HOME']).toMatch(/acde-test-[^/\\]+[/\\]config$/)
      expect(started.env!['HOME']).toMatch(/acde-test-[^/\\]+[/\\]home$/)
    }
    expect(new Set(run.started.map((e) => e.env!['XDG_CONFIG_HOME'])).size).toBe(4)
    expect(run.started[0]!.argv).toEqual(['app', 'alpha'])
    const left = join(s.project, '.acde/test-results/e2e-broken/looks-for-what-is-not-there')
    const saved = 'error.txt, output.log, screen.png, snapshot.txt, console.txt, network.txt, trace.txt'
    expect(run.out).toContain(`acde test: saved ${saved} in ${left}`)
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
    expect(one.out).toContain(`acde test: ${TASKS} (headed)`)
    expect(one.out).toContain('acde test: 1 file, 1 passed, 0 failed')
    expect(one.started.map((e) => e.headless)).toEqual([null])
    const bail = await acdeTest(s, ['--bail'])
    expect(bail.out).toContain(`acde test: 1 file, 0 passed, 1 failed, 1 not run (--bail): ${BROKEN}`)
    expect((await acdeTest(s, ['unit.test.ts'])).out).toContain('unit.test.ts: an e2e test file is named *.e2e.ts')
    expect((await acdeTest(s, ['nope'])).out).toContain('acde: nope: no such file or directory')
    mkdirSync(join(s.root, 'empty'))
    writeFileSync(join(s.root, 'empty/acde.config.jsonc'), '{"type":"app","id":"empty"}')
    expect((await acdeTest(s, [join(s.root, 'empty')])).out)
      .toContain('acde: no e2e tests (**/*.e2e.{ts,tsx,js,mjs,mts})')
    expect((await acdeTest(s, ['--timeout', 'soon'])).out).toContain('--timeout soon: milliseconds per test')
  }, 120_000)

  test('-t skips the files where it matches no test; a filter that matches nothing anywhere fails', async () => {
    const s = project()
    const some = await acdeTest(s, ['-t', 'adds'])
    expect(some.out).toContain(`acde test: ${BROKEN}: no test matches -t "adds", skipped`)
    expect(some.out).toContain('acde test: 1 file, 1 passed, 0 failed, 1 skipped (no test matches -t)')
    expect(some.code).toBe(0)
    expect(some.started.length).toBe(1)
    const none = await acdeTest(s, ['-t', 'nothing at all'])
    expect(none.out).toContain('acde test: no test matches -t "nothing at all" in 2 files')
    expect(none.code).toBe(1)
  }, 120_000)

  const ci = 'in CI (CI set) the tests run, and a missing screenshot baseline is an error instead of being written'
  test(ci, async () => {
    const s = project()
    const run = await acdeTest(s, [TASKS], { CI: '1' })
    expect(run.out).toContain('acde test: 1 file, 1 passed, 0 failed')
    expect(run.code).toBe(0)
    writeFileSync(join(s.project, 'e2e/look.e2e.ts'), `import { test, expect } from 'acde/test'
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
      writeFileSync(file, `import { test, expect } from 'acde/test'

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
    expect(first.out).toContain(`acde: wrote screenshot ${baseline}`)
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
    expect(updated.out).toContain(`acde: updated screenshot ${baseline}`)
    expect(updated.out).toContain(`acde test: trace of "the empty list": ${join(left, 'trace.txt')}`)
    expect(readdirSync(left).sort()).toEqual(['trace', 'trace.html', 'trace.txt'])
    expect(readFileSync(join(left, 'trace.html'), 'utf8'))
      .toContain('expect window(app &quot;alpha&quot;) to match screenshot the-empty-list-1')
    expect(readdirSync(join(left, 'trace')).length).toBeGreaterThan(5)
    expect((await acdeTest(s, [])).code).toBe(0)
    expect(existsSync(left)).toBe(false)
  }, 120_000)
})

describe('acde test in a project managed by npm', () => {
  const runtime = 'the driver starts acde dev on the runtime of the project itself, ' +
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
    expect(run.out).toContain('acde test: 1 file, 1 passed, 0 failed')
    expect(run.code).toBe(0)
  }, 120_000)
})

interface Built {
  readonly compilerOptions: { paths: Record<string, string[]> }
}

describe('TestTsconfig', () => {
  const resolves = 'acde/test and acde/driver resolve to this acde; the project\'s own paths stay, ' +
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
    expect(app.compilerOptions.paths['acde/test']).toEqual([TestTsconfig.MODULES['acde/test']!])
    expect(app.compilerOptions.paths['acde/driver']).toEqual([join(import.meta.dir, '../src/driver/index.ts')])
    expect(TestTsconfig.paths(join(root, 'pkg/tsconfig.json')))
      .toEqual({ '#lib/*': [join(root, 'node_modules/@acme/tsconfig/lib/*')] })
    const lone = TestTsconfig.build(join(root, 'lone')) as Built & { extends?: string }
    expect(lone.extends).toBeUndefined()
    expect(Object.keys(lone.compilerOptions.paths).sort()).toEqual(['acde/driver', 'acde/test'])
  })
})
