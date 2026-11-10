import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { cliEnv } from 'acde/launcher'
import { E2E_FILE, SKIPPED } from '../paths.ts'
import { Runtime } from '../runtime.ts'
import { E2e } from './settings.ts'
import { TestTsconfig } from './tsconfig.ts'

export interface RunnerOptions {
  readonly targets: readonly string[]
  readonly desktop?: string
  readonly headed?: boolean
  readonly pattern?: string
  readonly bail?: boolean
  readonly trace?: boolean
  readonly update?: boolean
  readonly timeout?: number
  readonly cwd?: string
}

interface Suite {
  readonly file: string
  readonly project: string
}

export class TestRunner {
  static readonly PATTERN = '**/*.e2e.{ts,tsx,js,mjs,mts}'

  static suites(targets: readonly string[], cwd: string): Suite[] {
    const suites: Suite[] = []
    for (const target of targets.length ? targets : ['.']) {
      const path = resolve(cwd, target)
      if (!existsSync(path)) throw new Error(`${target}: no such file or directory`)
      if (statSync(path).isFile()) {
        if (!E2E_FILE.test(path))
          throw new Error(`${target}: an e2e test file is named *.e2e.ts (or .tsx, .js, .mjs, .mts)`)
        const project = E2e.project(path)
        if (!project) throw new Error(`${target}: no acde project (acde.config.jsonc) holds it`)
        suites.push({ file: path, project })
        continue
      }
      const project = E2e.project(path)
      if (!project) throw new Error(`${target}: not an acde project (no acde.config.jsonc here or above)`)
      const found = [...new Bun.Glob(TestRunner.PATTERN).scanSync({ cwd: path, onlyFiles: true, dot: false })]
        .filter((file) => !file.split(/[\\/]/).some((part) => SKIPPED.has(part)))
        .sort()
        .map((file) => join(path, file))
      for (const file of found) suites.push({ file, project: E2e.project(file) ?? project })
    }
    const seen = new Set<string>()
    return suites.filter((s) => !seen.has(s.file) && !!seen.add(s.file))
  }

  static async run(options: RunnerOptions): Promise<number> {
    if (!Runtime.bun) {
      throw new Error('acde test needs bun (the tests run on bun test): install it from https://bun.sh, ' +
        'then run acde test again')
    }
    const cwd = options.cwd ?? process.cwd()
    const suites = TestRunner.suites(options.targets, cwd)
    const where = (options.targets.length ? options.targets : ['.']).join(', ')
    if (!suites.length) throw new Error(`no e2e tests (${TestRunner.PATTERN}) in ${where}`)
    const bun = process.execPath
    const scratch = mkdtempSync(join(tmpdir(), 'acde-test-run-'))
    try {
      return await TestRunner.#suites(suites, options, cwd, bun, scratch)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  static async #suites(
    suites: readonly Suite[], options: RunnerOptions, cwd: string, bun: string, scratch: string,
  ): Promise<number> {
    const tsconfigs = new Map<string, string>()
    const tsconfig = (project: string) => {
      let file = tsconfigs.get(project)
      if (file === undefined) {
        file = join(scratch, `tsconfig-${tsconfigs.size}.json`)
        writeFileSync(file, `${JSON.stringify(TestTsconfig.build(project), null, 2)}\n`)
        tsconfigs.set(project, file)
      }
      return file
    }
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
        trace: options.trace === true,
        update: options.update === true,
      }
      const argv = [
        bun, 'test', suite.file, '--tsconfig-override', tsconfig(suite.project), '--timeout', String(settings.timeout),
        ...(options.pattern !== undefined ? ['--test-name-pattern', options.pattern] : []),
      ]
      console.log(`acde test: ${relative(cwd, suite.file) || suite.file}${settings.headless ? '' : ' (headed)'}`)
      const env = cliEnv(bun, { ...process.env, ...E2e.env(settings) })
      const child = Runtime.spawn(argv, { cwd: suite.project, env, stdio: 'inherit' })
      const code = await child.exited
      ran++
      if (code !== 0) {
        failed.push(relative(cwd, suite.file) || suite.file)
        if (existsSync(results)) kept.add(results)
        if (options.bail) break
      }
    }
    const skipped = suites.length - ran
    const files = `${ran} file${ran === 1 ? '' : 's'}`
    const notRun = skipped ? `, ${skipped} not run (--bail)` : ''
    const summary = `acde test: ${files}, ${ran - failed.length} passed, ${failed.length} failed${notRun}`
    const left = kept.size ? `\n  what the failing tests left: ${[...kept].join(', ')}` : ''
    console.log(failed.length ? `${summary}: ${failed.join(', ')}${left}` : summary)
    return failed.length ? 1 : 0
  }

  static #desktop(value: string, cwd: string): string {
    const path = /[\\/]/.test(value) || value === '.' || value === '..' || existsSync(resolve(cwd, value))
    return path ? resolve(cwd, value) : value
  }
}
