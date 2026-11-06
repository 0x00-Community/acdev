import { test as bunTest, expect as bunExpect, type Matchers } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Acde } from '../driver/acde.ts'
import { expect as expectUi, type LocatorAssertions, type WindowAssertions } from '../driver/expect.ts'
import { Format } from '../driver/format.ts'
import { Locator } from '../driver/locator.ts'
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
    const base = join(settings.results, ...(settings.file ? [E2e.slug(settings.file.replace(/\.e2e\.[cm]?[jt]sx?$/, ''))] : []), E2e.slug(name))
    const seen = E2eRun.#used.get(base) ?? 0
    E2eRun.#used.set(base, seen + 1)
    return seen ? `${base}-${seen + 1}` : base
  }

  static async run(name: string, body: Body, settings: E2eSettings = E2e.read()): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'acde-test-'))
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
      })
      const app = acde.session.desktop === null && acde.session.apps[0] !== undefined ? acde.window(acde.session.apps[0]) : null
      await body({ acde, app, home: join(home, 'home'), settings })
    } catch (error) {
      const dir = E2eRun.results(settings, name)
      const saved = await E2eRun.keep(acde, error, dir)
      if (error instanceof Error) error.message += `\n\n${saved}`
      throw error
    } finally {
      await acde?.close()
      rmSync(home, { recursive: true, force: true })
    }
  }

  static async keep(acde: Acde | null, error: unknown, dir: string): Promise<string> {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const wrote: string[] = []
    const write = (file: string, text: string) => {
      writeFileSync(join(dir, file), text.endsWith('\n') ? text : `${text}\n`)
      wrote.push(file)
    }
    write('error.txt', error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error))
    if (acde?.logs) write('output.log', acde.logs.tail(5000).text)
    if (acde && !acde.closed) {
      const steps: [string, () => Promise<void>][] = [
        ['screen.png', async () => void (await acde.screen({ path: join(dir, 'screen.png') }), wrote.push('screen.png'))],
        ['snapshot.txt', async () => write('snapshot.txt', (await acde.snapshot({ all: true, offscreen: true })).text)],
        ['console.txt', async () => write('console.txt', (await acde.console({ limit: 5000 })).entries.map(Format.console).join('\n'))],
        ['network.txt', async () => write('network.txt', (await acde.network({ limit: 5000 })).entries.map(Format.request).join('\n'))],
      ]
      for (const [file, step] of steps) {
        try {
          await step()
        } catch (failure) {
          write(`${file}.error.txt`, (failure as Error)?.message ?? String(failure))
        }
      }
    }
    return `acde test: saved ${wrote.join(', ')} in ${dir}`
  }
}

type Register = (name: string, fn: () => Promise<void>, timeout?: number) => void

function register(add: Register) {
  return (name: string, body: Body, options?: TestOptions): void => {
    const settings = E2e.read()
    const timeout = typeof options === 'number' ? options : (options?.timeout ?? settings.timeout)
    add(name, () => E2eRun.run(name, body, settings), timeout)
  }
}

export const test = Object.assign(register(bunTest), {
  only: register(bunTest.only),
  skip: register(bunTest.skip),
  todo: (name: string): void => bunTest.todo(name),
  if: (condition: boolean) => register(bunTest.if(condition)),
})

export function expect(target: Locator): LocatorAssertions
export function expect(target: AppWindow): WindowAssertions
export function expect<T>(value: T): Matchers<T>
export function expect(target: unknown): unknown {
  if (target instanceof Locator) return expectUi(target)
  if (target instanceof AppWindow) return expectUi(target)
  return bunExpect(target)
}
