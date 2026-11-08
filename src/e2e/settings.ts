import { existsSync, statSync } from 'node:fs'
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
}

export class E2e {
  static readonly DIRS = 'ACDE_TEST_DIRS'
  static readonly DESKTOP = 'ACDE_TEST_DESKTOP'
  static readonly HEADLESS = 'ACDE_TEST_HEADLESS'
  static readonly RESULTS = 'ACDE_TEST_RESULTS'
  static readonly FILE = 'ACDE_TEST_FILE'
  static readonly TIMEOUT = 'ACDE_TEST_TIMEOUT'
  static readonly TIMEOUT_MS = 60_000
  static readonly SIZE = '1280x800'

  static env(settings: E2eSettings): Record<string, string> {
    return {
      [E2e.DIRS]: JSON.stringify(settings.dirs),
      [E2e.HEADLESS]: settings.headless ? '1' : '0',
      [E2e.RESULTS]: settings.results,
      [E2e.TIMEOUT]: String(settings.timeout),
      ...(settings.desktop !== null && { [E2e.DESKTOP]: settings.desktop }),
      ...(settings.file !== null && { [E2e.FILE]: settings.file }),
    }
  }

  static read(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): E2eSettings {
    const given = env[E2e.DIRS]
    const dirs = given ? (JSON.parse(given) as string[]) : [E2e.project(cwd) ?? cwd]
    const timeout = Number(env[E2e.TIMEOUT])
    return {
      dirs,
      desktop: env[E2e.DESKTOP] || null,
      headless: env[E2e.HEADLESS] !== '0',
      results: env[E2e.RESULTS] || join(dirs[0]!, '.acde', 'test-results'),
      file: env[E2e.FILE] || null,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : E2e.TIMEOUT_MS,
    }
  }

  static project(from: string): string | null {
    return up(resolve(from), (dir) => existsSync(dir) && statSync(dir).isDirectory() && CONFIGS.some((name) => existsSync(join(dir, name))) && dir)
  }

  static slug(text: string): string {
    return slug(text).slice(0, 80) || 'test'
  }
}
