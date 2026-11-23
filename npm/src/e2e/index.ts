import { test as bunTest, expect as bunExpect, type Matchers } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { packageRoot } from 'acdev/launcher'
import { Acde, LaunchError } from '../driver/acde.ts'
import { expect as expectUi, type LocatorAssertions, type WindowAssertions } from '../driver/expect.ts'
import { Format } from '../driver/format.ts'
import { Locator } from '../driver/locator.ts'
import { Logs } from '../driver/logs.ts'
import { Poll } from '../driver/poll.ts'
import { Screenshots } from '../driver/screenshot.ts'
import { Sessions } from '../sessions.ts'
import { Video } from '../driver/video.ts'
import { AppWindow } from '../driver/window.ts'
import { E2e, type E2eSettings } from './settings.ts'
import * as Evidence from '../evidence/index.ts'
import { guestJournal } from '../evidence/guest.ts'
import * as Timeline from '../timeline/index.ts'

export { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test'
export * from '../driver/index.ts'
export { E2e, type E2eSettings } from './settings.ts'

export interface Fixtures {
  readonly acde: Acde
  readonly app: AppWindow | null
  readonly home: string
  readonly settings: E2eSettings
}

export type Body = (fixtures: Fixtures) => unknown

export interface TestSetup {
  readonly size?: readonly [number, number]
  readonly localStorage?: Readonly<Record<string, string>>
}

export type TestOptions = number | ({ readonly timeout?: number } & TestSetup)

export class TestTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export class E2eRun {
  static readonly #used = new Map<string, number>()
  static readonly MARGIN_MS = 3_000
  static readonly GRACE_MS = 30_000
  static readonly KEEP_MS = 15_000
  static readonly VIDEO_MS = 5_000

  static startTimeout(timeout: number): number {
    return Math.max(timeout / 2, timeout - E2eRun.MARGIN_MS)
  }

  static softFailures: Error[] | null = null

  static env(home: string): Record<string, string> {
    const dir = (name: string) => {
      const path = join(home, name)
      mkdirSync(path, { recursive: true })
      return path
    }
    return {
      HOME: dir('home'),
      XDG_CONFIG_HOME: dir('config'),
      XDG_DATA_HOME: dir('data'),
      XDG_STATE_HOME: dir('state'),
      XDG_CACHE_HOME: dir('cache'),
      ACDE_STORAGE: '',
      ACDE_SIZE: E2e.SIZE,
      ACDE_COLOR_SCHEME: 'light',
      ACDE_AUTOSTART: '0',
      [Sessions.TEST_ENV]: '1',
    }
  }

  static results(settings: E2eSettings, name: string): string {
    const file = settings.file ? [E2e.slug(settings.file.replace(/\.e2e\.[cm]?[jt]sx?$/, ''))] : []
    const base = join(settings.results, ...file, E2e.slug(name))
    const seen = E2eRun.#used.get(base) ?? 0
    E2eRun.#used.set(base, seen + 1)
    return seen ? `${base}-${seen + 1}` : base
  }

  static screenshots(settings: E2eSettings): string {
    const file = settings.file !== null ? resolve(settings.dirs[0]!, settings.file) : Bun.main
    return join(dirname(file), '__screenshots__', basename(file))
  }

  static async run(
    name: string, body: Body, settings: E2eSettings = E2e.read(), timeout = settings.timeout, setup: TestSetup = {},
    results = E2eRun.results(settings, name),
  ): Promise<void> {
    const deadline = Date.now() + timeout
    const home = mkdtempSync(join(tmpdir(), 'acde-test-'))
    rmSync(results, { recursive: true, force: true })
    let video: Video | null = null
    Screenshots.context = {
      dir: E2eRun.screenshots(settings), results, update: settings.update, ci: !!process.env['CI'], test: name,
    }
    let acde: Acde | null = null
    try {
      acde = await E2eRun.#session(settings, home, timeout)
      acde.trace.screenshots = settings.trace
      if (settings.video !== 'off') video = Video.start(acde)
      const first = acde.session.apps[0]
      const app = acde.session.desktop === null && first !== undefined ? acde.window(first) : null
      if ((setup.size || setup.localStorage) && !app) {
        throw new Error('size and localStorage set up the app window; this run has a desktop or no app')
      }
      const fixtures = { acde, app, home: settings.guestHome ?? join(home, 'home'), settings }
      const how = 'its timeout: --timeout, or the one given to test()'
      const late = () => new TestTimeout(`the test did not finish within ${timeout} ms (${how})`)
      E2eRun.softFailures = []
      await E2eRun.within(deadline - Date.now(), async () => {
        if (setup.localStorage) await app!.seedLocalStorage(setup.localStorage)
        if (setup.size) await app!.resize(setup.size[0], setup.size[1])
        return body(fixtures)
      }, late)
      const soft = E2eRun.softFailures
      if (soft.length) {
        const list = soft.map((e, i) => `  ${i + 1}. ${e.message.split('\n').join('\n     ')}`).join('\n')
        throw new Error(`${soft.length} soft assertion${soft.length === 1 ? '' : 's'} failed:\n${list}`)
      }
      if (settings.trace) {
        const trace = acde.trace.write(results, name).map((f) => join(results, f))[0]
        console.log(`acdev test: trace of ${JSON.stringify(name)}: ${trace}`)
      }
      if (video && settings.video === 'on') {
        console.log(`acdev test: video of ${JSON.stringify(name)}: ${await E2eRun.#video(video, results)}`)
      }
    } catch (error) {
      E2eRun.ownFrames(error)
      if (video) await E2eRun.#video(video, results)
      const saved = await E2eRun.keep(acde, error, results, name, new Date(deadline - timeout))
      if (error instanceof Error) error.message += `\n\n${saved}`
      throw error
    } finally {
      E2eRun.softFailures = null
      Screenshots.context = null
      await acde?.close()
      await video?.stop()
      rmSync(home, { recursive: true, force: true })
    }
  }

  static async #session(settings: E2eSettings, home: string, timeout: number): Promise<Acde> {
    if (settings.guestHome !== null) return await Acde.attach({ session: 'vm' })
    const one = settings.dirs.length === 1 && settings.desktop === null
    return await Acde.launch({
      dirs: settings.dirs,
      env: E2eRun.env(home),
      headless: settings.headless,
      ...(settings.desktop !== null && { desktop: settings.desktop }),
      ...(one && { out: settings.out }),
      cwd: settings.dirs[0]!,
      startTimeout: E2eRun.startTimeout(timeout),
      force: true,
    })
  }

  static async #video(video: Video, dir: string): Promise<string> {
    const late = () => new Error(`acdev runtime did not answer within the ${E2eRun.VIDEO_MS / 1000} s left for the video`)
    try {
      await E2eRun.within(E2eRun.VIDEO_MS, () => video.stop(), late)
    } catch (failure) {
      return `not saved: ${(failure as Error).message}`
    }
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'video.png')
    const wrote = video.write(path)
    if (!wrote) return 'no frames'
    return `${path} (${wrote.frames} frames${wrote.dropped ? `, the first ${wrote.dropped} dropped` : ''})`
  }

  static ownFrames(error: unknown, root = packageRoot()): void {
    if (!(error instanceof Error) || !error.stack) return
    const inside = [join(root, 'dist') + sep, join(root, 'src') + sep, join(root, 'launcher.mjs')]
    const lines = error.stack.split('\n')
    const frame = (line: string) => /^\s+at /.test(line)
    const internal = (line: string) =>
      inside.some((dir) => line.includes(dir)) || /\((native|node:|internal:)[^)]*\)$/.test(line)
    const kept = lines.filter((line) => !frame(line) || !internal(line))
    if (kept.some(frame)) error.stack = kept.join('\n')
  }

  static async within<T>(ms: number, work: () => Promise<T>, late: () => Error): Promise<T> {
    const timer = new AbortController()
    const working = work()
    working.catch(() => undefined)
    const timed = sleep(Math.max(0, ms), null, { signal: timer.signal }).then(() => {
      throw late()
    })
    timed.catch(() => undefined)
    try {
      return await Promise.race([working, timed])
    } finally {
      timer.abort()
    }
  }

  static async keep(acde: Acde | null, error: unknown, dir: string, name = basename(dir), since = new Date()): Promise<string> {
    const logs = acde?.logs ?? (error instanceof LaunchError ? error.logs : null)
    const journal = acde?.guest ? guestJournal : null
    const timeline = acde ? Timeline.since(acde) : null
    const capture = { label: name, since, error, output: logs ? logs.tail(Logs.KEEP).text : null, journal, timeline, budgetMs: E2eRun.KEEP_MS }
    const kept = await Evidence.write(acde, capture, dir)
    const wrote = kept.items.map((item) => (item.ok ? item.file : `${item.file}.error.txt`))
    if (acde) wrote.push(...acde.trace.write(dir, name))
    return `acdev test: saved ${wrote.join(', ')} in ${dir}`
  }
}

type Register = (name: string, fn: () => Promise<void>, timeout?: number) => void

function register(add: () => Register) {
  function define(name: string, body: Body, options?: TestOptions): void
  function define(name: string, options: TestOptions, body: Body): void
  function define(name: string, second: Body | TestOptions, third?: Body | TestOptions): void {
    const [body, options] =
      typeof second === 'function' ? [second, third as TestOptions | undefined] : [third as Body, second]
    if (typeof body !== 'function') {
      const forms = 'test(name, body, options?) or test(name, options, body)'
      throw new TypeError(`test ${JSON.stringify(name)}: give the test body as a function, ${forms}`)
    }
    defineTest(add, name, body, options)
  }
  return define
}

function defineTest(add: () => Register, name: string, body: Body, options: TestOptions | undefined): void {
  const settings = E2e.read()
  const timeout = typeof options === 'number' ? options : (options?.timeout ?? settings.timeout)
  const given = typeof options === 'object' ? options : {}
  const setup: TestSetup = {
    ...(given.size && { size: given.size }),
    ...(given.localStorage && { localStorage: given.localStorage }),
  }
  const attempts = 1 + settings.retries
  E2e.mark('registered', name)
  add()(name, async () => {
    E2e.mark('ran', name)
    const results = E2eRun.results(settings, name)
    const quoted = JSON.stringify(name)
    for (let attempt = 1; ; attempt++) {
      try {
        await E2eRun.run(name, body, settings, timeout, setup, attempt === 1 ? results : `${results}.attempt-${attempt}`)
        if (attempt > 1) console.log(`acdev test: ${quoted} passed on attempt ${attempt} of ${attempts} (flaky)`)
        return
      } catch (error) {
        if (attempt >= attempts) throw error
        const why = (error instanceof Error ? error.message : String(error)).split('\n')[0]
        console.log(`acdev test: ${quoted} failed on attempt ${attempt} of ${attempts}, trying again: ${why}`)
      }
    }
  }, (timeout + E2eRun.GRACE_MS) * attempts)
}

export const test = Object.assign(
  register(() => bunTest),
  {
    only: register(() => bunTest.only),
    skip: register(() => bunTest.skip),
    todo: (name: string): void => bunTest.todo(name),
    if: (condition: boolean) => register(() => bunTest.if(condition)),
  },
)

type Asynced<M> = {
  [K in keyof M]: M[K] extends (...args: infer A) => unknown
    ? (...args: A) => Promise<void>
    : M[K] extends object ? Asynced<M[K]> : never
}

export type PollMatchers<T> = Asynced<Omit<Matchers<T>, 'resolves' | 'rejects'>>

export interface PollOptions {
  readonly timeout?: number
  readonly message?: string
}

function matchersOf(target: unknown): unknown {
  return target instanceof Locator || target instanceof AppWindow ? expectUi(target) : bunExpect(target)
}

function polled(read: () => unknown, options: PollOptions, path: readonly PropertyKey[]): unknown {
  return new Proxy(() => undefined, {
    get: (_, key) => (key === 'then' ? undefined : polled(read, options, [...path, key])),
    apply: async (_, __, args: unknown[]) => {
      const timeout = options.timeout ?? Acde.TIMEOUT_MS
      let last: unknown = null
      await Poll.until(timeout, async () => {
        try {
          let target = bunExpect(await read()) as unknown as Record<PropertyKey, unknown>
          for (const key of path.slice(0, -1)) target = target[key] as Record<PropertyKey, unknown>
          ;(target[path[path.length - 1]!] as (...a: unknown[]) => unknown)(...args)
          return true
        } catch (error) {
          last = error
          return null
        }
      }, () => {
        const why = last instanceof Error ? last.message : String(last)
        const said = options.message ? `${options.message}: ` : ''
        return new Error(`${said}expect.poll did not pass within ${timeout} ms: ${why}`)
      })
    },
  })
}

function softly(target: unknown, failures: Error[]): unknown {
  if (typeof target !== 'object' && typeof target !== 'function') return target
  return new Proxy(target as object, {
    get: (object, key) => {
      const value = Reflect.get(object, key, object) as unknown
      if (key === 'not' || key === 'resolves' || key === 'rejects') return softly(value, failures)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const keep = (error: unknown) => void failures.push(error instanceof Error ? error : new Error(String(error)))
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(object, args)
          return result instanceof Promise ? result.catch(keep) : result
        } catch (error) {
          keep(error)
          return undefined
        }
      }
    },
  })
}

function expectAny(target: Locator): LocatorAssertions
function expectAny(target: AppWindow): WindowAssertions
function expectAny<T>(value: T): Matchers<T>
function expectAny(target: unknown): unknown {
  return matchersOf(target)
}

function soft(target: Locator): LocatorAssertions
function soft(target: AppWindow): WindowAssertions
function soft<T>(value: T): Matchers<T>
function soft(target: unknown): unknown {
  const failures = E2eRun.softFailures
  if (!failures) throw new Error('expect.soft works inside an acdev test: the failures are reported when the test ends')
  return softly(matchersOf(target), failures)
}

export const expect = Object.assign(expectAny, {
  poll: <T>(read: () => T | Promise<T>, options: PollOptions = {}): PollMatchers<Awaited<T>> =>
    polled(read, options, []) as PollMatchers<Awaited<T>>,
  soft,
})
