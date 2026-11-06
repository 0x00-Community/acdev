import { existsSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { cliEnv, findBun } from 'acde/launcher'
import { E2e } from './settings.ts'

export interface RunnerOptions {
  readonly targets: readonly string[]
  readonly desktop?: string
  readonly headed?: boolean
  readonly pattern?: string
  readonly bail?: boolean
  readonly timeout?: number
  readonly cwd?: string
}

interface Suite {
  readonly file: string
  readonly project: string
}

export class TestRunner {
  static readonly PATTERN = '**/*.e2e.{ts,tsx,js,mjs,mts}'
  static readonly SKIPPED = new Set(['node_modules', '.acde', '.git', 'dist', 'build', 'out', '.next', '.output', '.nuxt', '.svelte-kit', '.astro', '.turbo', '.cache'])

  static suites(targets: readonly string[], cwd: string): Suite[] {
    const suites: Suite[] = []
    for (const target of targets.length ? targets : ['.']) {
      const path = resolve(cwd, target)
      if (!existsSync(path)) throw new Error(`${target}: no such file or directory`)
      if (statSync(path).isFile()) {
        if (!/\.e2e\.[cm]?[jt]sx?$/.test(path)) throw new Error(`${target}: an e2e test file is named *.e2e.ts (or .tsx, .js, .mjs, .mts)`)
        const project = E2e.project(path)
        if (!project) throw new Error(`${target}: no acde project (acde.config.jsonc) holds it`)
        suites.push({ file: path, project })
        continue
      }
      const project = E2e.project(path)
      if (!project) throw new Error(`${target}: not an acde project (no acde.config.jsonc here or above)`)
      const found = [...new Bun.Glob(TestRunner.PATTERN).scanSync({ cwd: path, onlyFiles: true, dot: false })]
        .filter((file) => !file.split(/[\\/]/).some((part) => TestRunner.SKIPPED.has(part)))
        .sort()
        .map((file) => join(path, file))
      for (const file of found) suites.push({ file, project: E2e.project(file) ?? project })
    }
    const seen = new Set<string>()
    return suites.filter((s) => !seen.has(s.file) && !!seen.add(s.file))
  }

  static async run(options: RunnerOptions): Promise<number> {
    const cwd = options.cwd ?? process.cwd()
    const suites = TestRunner.suites(options.targets, cwd)
    if (!suites.length) throw new Error(`no e2e tests (${TestRunner.PATTERN}) in ${(options.targets.length ? options.targets : ['.']).join(', ')}`)
    const bun = await findBun()
    const cleaned = new Set<string>()
    const kept = new Set<string>()
    const failed: string[] = []
    let ran = 0
    for (const suite of suites) {
      const name = relative(suite.project, suite.file).split(sep).join('/')
      const results = join(suite.project, '.acde', 'test-results')
      if (!cleaned.has(results)) {
        rmSync(results, { recursive: true, force: true })
        cleaned.add(results)
      }
      const settings = {
        dirs: [suite.project],
        desktop: options.desktop === undefined ? null : TestRunner.#desktop(options.desktop, cwd),
        headless: options.headed !== true,
        results,
        file: name,
        timeout: options.timeout ?? E2e.TIMEOUT_MS,
      }
      const argv = [bun, 'test', suite.file, '--timeout', String(settings.timeout), ...(options.pattern !== undefined ? ['--test-name-pattern', options.pattern] : [])]
      console.log(`acde test: ${relative(cwd, suite.file) || suite.file}${settings.headless ? '' : ' (headed)'}`)
      const child = Bun.spawn(argv, { cwd: suite.project, env: cliEnv(bun, { ...process.env, ...E2e.env(settings) }), stdio: ['inherit', 'inherit', 'inherit'] })
      const code = await child.exited
      ran++
      if (code !== 0) {
        failed.push(relative(cwd, suite.file) || suite.file)
        if (existsSync(results)) kept.add(results)
        if (options.bail) break
      }
    }
    const skipped = suites.length - ran
    const summary = `acde test: ${ran} file${ran === 1 ? '' : 's'}, ${ran - failed.length} passed, ${failed.length} failed${skipped ? `, ${skipped} not run (--bail)` : ''}`
    console.log(failed.length ? `${summary}: ${failed.join(', ')}${kept.size ? `\n  what the failing tests left: ${[...kept].join(', ')}` : ''}` : summary)
    return failed.length ? 1 : 0
  }

  static #desktop(value: string, cwd: string): string {
    return /[\\/]/.test(value) || value === '.' || value === '..' || existsSync(resolve(cwd, value)) ? resolve(cwd, value) : value
  }
}
