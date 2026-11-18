import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Acde } from '../../src/driver/index.ts'
import { cleanup, skipping, tmp } from '../helpers.ts'

const CLI = join(import.meta.dir, '../../src/cli.ts')
const DESK = join(import.meta.dir, '../fixtures/host/lockdesk')
const RUNTIME = process.env['ACDEV_RUNTIME'] ?? ''
const WANTED = process.env['ACDEV_HOST_E2E'] === '1'
const START_MS = 120_000

setDefaultTimeout(60_000)

const skip = skipping(!WANTED || !RUNTIME, 'host e2e: set ACDEV_HOST_E2E=1 and ACDEV_RUNTIME to a real acdev runtime (bun run test:host)')

describe.skipIf(skip)('acdev dev --lock opens the lock page alone, with the stand-in acde:lock', () => {
  let project = ''
  let env: Record<string, string> = {}
  let dev: ReturnType<typeof Bun.spawn> | null = null
  let driver: Acde | null = null

  beforeAll(async () => {
    const home = tmp()
    project = join(home, 'lockdesk')
    cpSync(DESK, project, { recursive: true })
    const runtimeDir = join(home, 'run')
    mkdirSync(runtimeDir, { mode: 0o700 })
    env = {
      ...process.env as Record<string, string>,
      ACDEV_RUNTIME: RUNTIME,
      ACDEV_BROWSER: 'none',
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
    }
    dev = Bun.spawn([process.execPath, CLI, 'dev', project, '--lock', '--headless', '--force'], {
      cwd: project, env, stdout: Bun.file(join(home, 'dev.out.log')), stderr: Bun.file(join(home, 'dev.err.log')),
    })
    const deadline = Date.now() + START_MS
    while (Date.now() < deadline) {
      if (dev.exitCode !== null) throw new Error(`acdev dev --lock exited (${dev.exitCode})`)
      driver = await Acde.attach({ cwd: project, env }).catch(() => null)
      const title = driver ? await driver.evaluate('desktop', 'document.title').catch(() => null) : null
      if (title === 'Locked') return
      await driver?.close()
      driver = null
      await Bun.sleep(1000)
    }
    throw new Error(`the lock page did not open within ${START_MS / 1000} s`)
  }, START_MS + 10_000)

  afterAll(async () => {
    await driver?.close()
    if (dev && dev.exitCode === null) {
      dev.kill('SIGTERM')
      await Promise.race([dev.exited, Bun.sleep(10_000)])
      if (dev.exitCode === null) dev.kill('SIGKILL')
    }
    cleanup()
  })

  const unlock = (password: string) => driver!.evaluate('desktop', `(async () => {
    const { lock } = await import('acde:lock')
    try {
      await lock.unlock(${JSON.stringify(password)})
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error.code, status: error.status, retryAfter: error.retryAfter ?? null }
    }
  })()`)

  test('the lock page shows the stand-in user', async () => {
    const user = await driver!.evaluate('desktop', "import('acde:lock').then(({ lock }) => lock.user())")
    expect(user).toEqual({ name: 'dev', fullName: 'acdev developer', avatar: null })
    expect(await driver!.evaluate('desktop', "document.querySelector('#user').textContent")).toBe('acdev developer')
  })

  test('the right password unlocks; the three failures say why', async () => {
    expect(await unlock('right-password')).toEqual({ ok: true })
    expect(await unlock('wrong-password')).toEqual({ ok: false, code: 'auth', status: 403, retryAfter: null })
    expect(await unlock('busy-password')).toEqual({ ok: false, code: 'busy', status: 409, retryAfter: null })
    expect(await unlock('throttled-password')).toEqual({ ok: false, code: 'throttled', status: 429, retryAfter: 3 })
  })

  test('the lock page gets no shell modules: no acde:session', async () => {
    const session = await driver!.evaluate('desktop', "import('acde:session').then(() => 'given', () => 'refused')")
    expect(session).toBe('refused')
  })
})
