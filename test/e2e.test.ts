import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { E2e } from '../src/e2e/settings.ts'
import { cleanup, standIn } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const MODULE = join(import.meta.dir, '../src/e2e/index.ts')

afterAll(cleanup)

const PASSING = `import { test, expect } from ${JSON.stringify(MODULE)}

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

const FAILING = `import { test, expect } from ${JSON.stringify(MODULE)}

test('looks for what is not there', async ({ app }) => {
  await expect(app!.getByText('Nowhere')).toBeVisible({ timeout: 200 })
})

test('fine', async ({ acde }) => {
  expect((await acde.webs()).length).toBe(2)
})
`

function project() {
  const s = standIn()
  mkdirSync(join(s.project, 'e2e'))
  writeFileSync(join(s.project, 'e2e/tasks.e2e.ts'), PASSING)
  writeFileSync(join(s.project, 'e2e/broken.e2e.ts'), FAILING)
  writeFileSync(join(s.project, 'unit.test.ts'), "import { test } from 'bun:test'\ntest('not e2e', () => { throw new Error('acde test ran a unit test') })\n")
  return s
}

async function acdeTest(s: ReturnType<typeof standIn>, args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, 'test', ...args], { cwd: s.project, env: s.env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const started = readFileSync(s.env['FAKE_ACDERT_LOG']!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv?: string[]; headless?: string | null; env?: Record<string, string | null> }).filter((e) => e.argv)
  return { code, out: stdout + stderr, started }
}

describe('acde test', () => {
  test('runs every *.e2e.ts in its own bun test; a fresh isolated headless acde dev per test; a failure leaves what it saw', async () => {
    const s = project()
    const run = await acdeTest(s, [])
    expect(run.code).toBe(1)
    expect(run.out).toContain('acde test: e2e/broken.e2e.ts\n')
    expect(run.out).toContain('acde test: e2e/tasks.e2e.ts\n')
    expect(run.out).toContain('acde test: 2 files, 1 passed, 1 failed: e2e/broken.e2e.ts')
    expect(run.out).not.toContain('acde test ran a unit test')
    expect(run.out).toContain('expected window(app "alpha").getByText("Nowhere") to be visible within 200 ms; saw no element')
    expect(run.started.length).toBe(4)
    for (const started of run.started) {
      expect(started.headless).toBe('1')
      expect(started.env).toMatchObject({ ACDE_STORAGE: '', ACDE_SIZE: E2e.SIZE, ACDE_COLOR_SCHEME: 'light', ACDE_REDUCED_MOTION: '1', ACDE_AUTOSTART: '0' })
      expect(started.env!['XDG_CONFIG_HOME']).toMatch(/acde-test-[^/]+\/config$/)
      expect(started.env!['HOME']).toMatch(/acde-test-[^/]+\/home$/)
    }
    expect(new Set(run.started.map((e) => e.env!['XDG_CONFIG_HOME'])).size).toBe(4)
    expect(run.started[0]!.argv).toEqual(['app', 'alpha'])
    const left = join(s.project, '.acde/test-results/e2e-broken/looks-for-what-is-not-there')
    expect(run.out).toContain(`acde test: saved error.txt, output.log, screen.png, snapshot.txt, console.txt, network.txt in ${left}`)
    expect(readdirSync(left).sort()).toEqual(['console.txt', 'error.txt', 'network.txt', 'output.log', 'screen.png', 'snapshot.txt'])
    expect(readFileSync(join(left, 'error.txt'), 'utf8')).toContain('AssertionError: expected window(app "alpha").getByText("Nowhere")')
    expect(readFileSync(join(left, 'console.txt'), 'utf8')).toBe('   1 log    alpha#7  alpha ready\n')
    expect(readFileSync(join(left, 'screen.png')).subarray(1, 4).toString()).toBe('PNG')
    expect(existsSync(join(s.project, '.acde/test-results/e2e-tasks'))).toBe(false)
    expect(existsSync(join(s.project, '.acde/test/web'))).toBe(true)
  }, 120_000)

  test('--headed, -t, a file, --bail; mistakes are explained', async () => {
    const s = project()
    const one = await acdeTest(s, ['e2e/tasks.e2e.ts', '--headed', '-t', 'adds'])
    expect(one.code).toBe(0)
    expect(one.out).toContain('acde test: e2e/tasks.e2e.ts (headed)')
    expect(one.out).toContain('acde test: 1 file, 1 passed, 0 failed')
    expect(one.started.map((e) => e.headless)).toEqual([null])
    const bail = await acdeTest(s, ['--bail'])
    expect(bail.out).toContain('acde test: 1 file, 0 passed, 1 failed, 1 not run (--bail): e2e/broken.e2e.ts')
    expect((await acdeTest(s, ['unit.test.ts'])).out).toContain('unit.test.ts: an e2e test file is named *.e2e.ts')
    expect((await acdeTest(s, ['nope'])).out).toContain('acde: nope: no such file or directory')
    mkdirSync(join(s.root, 'empty'))
    writeFileSync(join(s.root, 'empty/acde.config.jsonc'), '{"type":"app","id":"empty"}')
    expect((await acdeTest(s, [join(s.root, 'empty')])).out).toContain('acde: no e2e tests (**/*.e2e.{ts,tsx,js,mjs,mts})')
    expect((await acdeTest(s, ['--timeout', 'soon'])).out).toContain('--timeout soon: milliseconds per test')
  }, 120_000)
})
