import { test as bunTest, expect as bunExpect, type Matchers } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { packageRoot } from 'acde/launcher'
import { Acde } from '../driver/acde.ts'
import { expect as expectUi, type LocatorAssertions, type WindowAssertions } from '../driver/expect.ts'
import { Format } from '../driver/format.ts'
import { Locator } from '../driver/locator.ts'
import { Screenshots } from '../driver/screenshot.ts'
import { AppWindow } from '../driver/window.ts'
import { E2e, type E2eSettings } from './settings.ts'

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

export type TestOptions = number | { readonly timeout?: number }

export class E2eRun {
  static readonly #used = new Map<string, number>()
  static readonly MARGIN_MS = 3_000

  static startTimeout(timeout: number): number {
    return Math.max(timeout / 2, timeout - E2eRun.MARGIN_MS)
  }

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
      ACDE_REDUCED_MOTION: '1',
      ACDE_AUTOSTART: '0',
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
    name: string, body: Body, settings: E2eSettings = E2e.read(), timeout = settings.timeout,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'acde-test-'))
    const results = E2eRun.results(settings, name)
    rmSync(results, { recursive: true, force: true })
    Screenshots.context = {
      dir: E2eRun.screenshots(settings), results, update: settings.update, ci: !!process.env['CI'], test: name,
    }
    let acde: Acde | null = null
    try {
      const one = settings.dirs.length === 1 && settings.desktop === null
      acde = await Acde.launch({
        dirs: settings.dirs,
        env: E2eRun.env(home),
        headless: settings.headless,
        ...(settings.desktop !== null && { desktop: settings.desktop }),
        ...(one && { out: join('.acde', 'test') }),
        cwd: settings.dirs[0]!,
        startTimeout: E2eRun.startTimeout(timeout),
      })
      acde.trace.screenshots = settings.trace
      const first = acde.session.apps[0]
      const app = acde.session.desktop === null && first !== undefined ? acde.window(first) : null
      await body({ acde, app, home: join(home, 'home'), settings })
      E2e.mark('passed', name)
      if (settings.trace) {
        const trace = acde.trace.write(results, name).map((f) => join(results, f))[0]
        console.log(`acde test: trace of ${JSON.stringify(name)}: ${trace}`)
      }
    } catch (error) {
      E2e.mark('failed', name)
      E2eRun.ownFrames(error)
      const saved = await E2eRun.keep(acde, error, results, name)
      if (error instanceof Error) error.message += `\n\n${saved}`
      throw error
    } finally {
      Screenshots.context = null
      await acde?.close()
      rmSync(home, { recursive: true, force: true })
    }
  }

  static ownFrames(error: unknown, root = packageRoot()): void {
    if (!(error instanceof Error) || !error.stack) return
    const inside = [join(root, 'dist') + sep, join(root, 'src') + sep, join(root, 'launcher.mjs')]
    const lines = error.stack.split('\n')
    const frame = (line: string) => /^\s+at /.test(line)
    const internal = (line: string) =>
      inside.some((dir) => line.includes(dir)) || /\((native|node:[^)]*|internal:[^)]*)\)$/.test(line)
    const kept = lines.filter((line) => !frame(line) || !internal(line))
    if (kept.some(frame)) error.stack = kept.join('\n')
  }

  static async keep(acde: Acde | null, error: unknown, dir: string, name = basename(dir)): Promise<string> {
    mkdirSync(dir, { recursive: true })
    const wrote: string[] = []
    const write = (file: string, text: string) => {
      writeFileSync(join(dir, file), text.endsWith('\n') ? text : `${text}\n`)
      wrote.push(file)
    }
    write('error.txt', error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error))
    if (acde?.logs) write('output.log', acde.logs.tail(5000).text)
    if (acde && !acde.closed) {
      const all = { limit: 5000 }
      const steps: [string, () => Promise<void>][] = [
        ['screen.png', async () => {
          await acde.screen({ path: join(dir, 'screen.png') })
          wrote.push('screen.png')
        }],
        ['snapshot.txt', async () => write('snapshot.txt', (await acde.snapshot({ all: true, offscreen: true })).text)],
        ['console.txt', async () => {
          write('console.txt', (await acde.console(all)).entries.map(Format.console).join('\n'))
        }],
        ['network.txt', async () => {
          write('network.txt', (await acde.network(all)).entries.map(Format.request).join('\n'))
        }],
      ]
      for (const [file, step] of steps) {
        try {
          await step()
        } catch (failure) {
          write(`${file}.error.txt`, (failure as Error)?.message ?? String(failure))
        }
      }
    }
    if (acde) wrote.push(...acde.trace.write(dir, name))
    return `acde test: saved ${wrote.join(', ')} in ${dir}`
  }
}

type Register = (name: string, fn: () => Promise<void>, timeout?: number) => void

function register(add: () => Register) {
  return (name: string, body: Body, options?: TestOptions): void => {
    const settings = E2e.read()
    const timeout = typeof options === 'number' ? options : (options?.timeout ?? settings.timeout)
    E2e.mark('registered', name)
    add()(name, () => {
      E2e.mark('ran', name)
      return E2eRun.run(name, body, settings, timeout)
    }, timeout)
  }
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

export function expect(target: Locator): LocatorAssertions
export function expect(target: AppWindow): WindowAssertions
export function expect<T>(value: T): Matchers<T>
export function expect(target: unknown): unknown {
  return target instanceof Locator || target instanceof AppWindow ? expectUi(target) : bunExpect(target)
}
