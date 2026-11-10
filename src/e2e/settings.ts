import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFIGS } from '../configs.ts'
import { slug, up } from '../paths.ts'

export interface E2eSettings {
  readonly dirs: readonly string[]
  readonly desktop: string | null
  readonly headless: boolean
  readonly results: string
  readonly file: string | null
  readonly timeout: number
  readonly trace: boolean
  readonly update: boolean
  readonly retries: number
  readonly video: VideoMode
  readonly out: string
}

export type VideoMode = 'off' | 'on' | 'failed'

export class E2e {
  static readonly DIRS = 'ACDE_TEST_DIRS'
  static readonly DESKTOP = 'ACDE_TEST_DESKTOP'
  static readonly HEADLESS = 'ACDE_TEST_HEADLESS'
  static readonly RESULTS = 'ACDE_TEST_RESULTS'
  static readonly FILE = 'ACDE_TEST_FILE'
  static readonly TIMEOUT = 'ACDE_TEST_TIMEOUT'
  static readonly TRACE = 'ACDE_TEST_TRACE'
  static readonly UPDATE = 'ACDE_TEST_UPDATE'
  static readonly MARKS = 'ACDE_TEST_MARKS'
  static readonly PATTERN = 'ACDE_TEST_PATTERN'
  static readonly RETRIES = 'ACDE_TEST_RETRIES'
  static readonly VIDEO = 'ACDE_TEST_VIDEO'
  static readonly OUT = 'ACDE_TEST_OUT'
  static readonly BUILD = join('.acde', 'test')
  static readonly TIMEOUT_MS = 60_000
  static readonly SIZE = '1280x800'

  static env(settings: E2eSettings): Record<string, string> {
    return {
      [E2e.DIRS]: JSON.stringify(settings.dirs),
      [E2e.HEADLESS]: settings.headless ? '1' : '0',
      [E2e.RESULTS]: settings.results,
      [E2e.TIMEOUT]: String(settings.timeout),
      [E2e.TRACE]: settings.trace ? '1' : '0',
      [E2e.UPDATE]: settings.update ? '1' : '0',
      [E2e.RETRIES]: String(settings.retries),
      [E2e.VIDEO]: settings.video,
      [E2e.OUT]: settings.out,
      ...(settings.desktop !== null && { [E2e.DESKTOP]: settings.desktop }),
      ...(settings.file !== null && { [E2e.FILE]: settings.file }),
    }
  }

  static read(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): E2eSettings {
    const given = env[E2e.DIRS]
    const dirs = given ? (JSON.parse(given) as string[]) : [E2e.project(cwd) ?? cwd]
    const timeout = Number(env[E2e.TIMEOUT])
    const retries = Number(env[E2e.RETRIES])
    const video = env[E2e.VIDEO]
    return {
      dirs,
      desktop: env[E2e.DESKTOP] || null,
      headless: env[E2e.HEADLESS] !== '0',
      results: env[E2e.RESULTS] || join(dirs[0]!, '.acde', 'test-results'),
      file: env[E2e.FILE] || null,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : E2e.TIMEOUT_MS,
      trace: env[E2e.TRACE] === '1',
      update: env[E2e.UPDATE] === '1',
      retries: Number.isInteger(retries) && retries > 0 ? retries : 0,
      video: video === 'on' || video === 'failed' ? video : 'off',
      out: env[E2e.OUT] || E2e.BUILD,
    }
  }

  static mark(kind: 'registered' | 'ran', name: string, env: NodeJS.ProcessEnv = process.env): void {
    const file = env[E2e.MARKS]
    if (!file) return
    const selected = kind === 'registered' && E2e.selects(env[E2e.PATTERN], name)
    appendFileSync(file, selected ? 'registered\nselected\n' : `${kind}\n`)
  }

  static selects(pattern: string | undefined, name: string): boolean {
    if (!pattern) return true
    try {
      return new RegExp(pattern).test(name)
    } catch {
      return true
    }
  }

  static unselected(marks: string): boolean {
    const lines = existsSync(marks) ? readFileSync(marks, 'utf8').split('\n') : []
    const count = (kind: string) => lines.filter((line) => line === kind).length
    return count('registered') > 0 && count('selected') === 0 && count('ran') === 0
  }

  static project(from: string): string | null {
    const holds = (dir: string) =>
      existsSync(dir) && statSync(dir).isDirectory() && CONFIGS.some((name) => existsSync(join(dir, name)))
    return up(resolve(from), (dir) => holds(dir) && dir)
  }

  static slug(text: string): string {
    return slug(text).slice(0, 80) || 'test'
  }
}
