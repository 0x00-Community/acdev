import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { cliEnv } from 'acdev/launcher'
import { Color, type Palette } from '../color.ts'
import { E2E_FILE, SKIPPED } from '../paths.ts'
import { Runtime } from '../runtime.ts'
import { cpus } from 'node:os'
import { E2e, type VideoMode } from './settings.ts'
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
  readonly workers?: number
  readonly retries?: number
  readonly video?: VideoMode
}

interface Suite {
  readonly file: string
  readonly project: string
}

export interface Tally {
  readonly ran: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

export interface Summary {
  readonly tallies: readonly Tally[]
  readonly uncounted: readonly string[]
  readonly failed: readonly string[]
  readonly files: number
  readonly filtered: number
  readonly unrun: number
}

export class TestRunner {
  static readonly PATTERN = '**/*.e2e.{ts,tsx,js,mjs,mts}'
  static readonly UNCOUNTED = 'bun test left no report: the file did not load, or its run was killed'

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

  static tally(report: string): Tally | null {
    let xml: string
    try {
      xml = readFileSync(report, 'utf8')
    } catch {
      return null
    }
    const root = /<testsuites\b([^>]*)>/.exec(xml)
    if (!root) return null
    const attributes = new Map([...root[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((found) => [found[1]!, found[2]!]))
    const count = (name: string) => (/^\d+$/.test(attributes.get(name) ?? '') ? Number(attributes.get(name)) : null)
    const tests = count('tests')
    const failed = count('failures')
    const skipped = count('skipped')
    if (tests === null || failed === null || skipped === null || failed + skipped > tests) return null
    return { ran: tests - skipped, passed: tests - skipped - failed, failed, skipped }
  }

  static summary(run: Summary, c: Palette = Color.palette(false)): string {
    const { tallies, uncounted, failed } = run
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const sum = (pick: (tally: Tally) => number) => tallies.reduce((total, tally) => total + pick(tally), 0)
    const skipped = sum((t) => t.skipped)
    const left = skipped ? `, ${skipped} not run (skipped, todo, or not matched by -t)` : ''
    const counted = `${plural(sum((t) => t.ran), 'test')} in ${plural(tallies.length, 'file')}`
    const parts = [
      tallies.length
        ? `${counted}: ${sum((t) => t.passed)} passed, ${sum((t) => t.failed)} failed${left}`
        : `${plural(run.files, 'file')} ran`,
      ...(failed.length ? [`failed: ${failed.join(', ')}`] : []),
      ...(uncounted.length ? [`not counted: ${uncounted.join(', ')} (${TestRunner.UNCOUNTED})`] : []),
      ...(run.filtered ? [`${plural(run.filtered, 'file')} skipped (no test matches -t)`] : []),
      ...(run.unrun ? [`${plural(run.unrun, 'file')} not run (--bail)`] : []),
    ]
    return `${(failed.length ? c.error : c.ok)('acdev test:')} ${parts.join('; ')}`
  }

  static async run(options: RunnerOptions): Promise<number> {
    if (!Runtime.bun) {
      throw new Error('acdev test needs bun (the tests run on bun test): install it from https://bun.sh, ' +
        'then run acdev test again')
    }
    const display = options.headed ? Runtime.noDisplay() : null
    if (display) throw new Error(`${display}: run acdev test without --headed`)
    const cwd = options.cwd ?? process.cwd()
    const suites = TestRunner.suites(options.targets, cwd)
    const where = (options.targets.length ? options.targets : ['.']).join(', ')
    if (!suites.length) {
      console.log(`acdev test: no e2e tests (${TestRunner.PATTERN}) in ${where} yet; nothing to run`)
      console.log(`acdev test: write one as e2e/app.e2e.ts (the acdev skill's testing guide: A first test)`)
      return 0
    }
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
    const results = (suite: Suite) => join(suite.project, '.acde', 'test-results')
    for (const dir of new Set(suites.map(results))) rmSync(dir, { recursive: true, force: true })
    const wanted = options.workers ?? (options.headed || options.bail ? 1 : TestRunner.defaultWorkers())
    const workers = Math.max(1, Math.min(suites.length, wanted))
    const parallel = workers > 1
    if (parallel) console.log(`acdev test: ${suites.length} files, ${workers} at a time`)
    const kept = new Set<string>()
    const failed: string[] = []
    const filtered: string[] = []
    const tallies: Tally[] = []
    const uncounted: string[] = []
    let ran = 0
    let next = 0
    let stop = false
    const one = async (suite: Suite, slot: number, index: number): Promise<void> => {
      const name = relative(suite.project, suite.file).split(sep).join('/')
      const settings = {
        dirs: [suite.project],
        desktop: options.desktop === undefined ? null : TestRunner.#desktop(options.desktop, cwd),
        headless: options.headed !== true,
        results: results(suite),
        file: name,
        timeout: options.timeout ?? E2e.TIMEOUT_MS,
        trace: options.trace === true,
        update: options.update === true,
        retries: options.retries ?? 0,
        video: options.video ?? 'off',
        out: slot === 0 ? E2e.BUILD : `${E2e.BUILD}-${slot + 1}`,
      }
      const report = join(scratch, `report-${index}.xml`)
      const argv = [
        bun, 'test', suite.file, '--tsconfig-override', tsconfig(suite.project), '--timeout', String(settings.timeout),
        '--reporter=junit', '--reporter-outfile', report,
        ...(options.pattern !== undefined ? ['--test-name-pattern', options.pattern] : []),
        ...(options.bail ? ['--bail'] : []),
      ]
      const shown = relative(cwd, suite.file) || suite.file
      const header = `acdev test: ${shown}${settings.headless ? '' : ' (headed)'}`
      if (!parallel) console.log(header)
      const marks = join(scratch, `marks-${index}.txt`)
      const env = cliEnv(bun, {
        ...process.env,
        ...E2e.env(settings),
        [E2e.MARKS]: marks,
        ...(options.pattern !== undefined && { [E2e.PATTERN]: options.pattern }),
      })
      const child = Runtime.spawn(argv, { cwd: suite.project, env, stdio: parallel ? 'pipe' : 'inherit' })
      const { stdout, stderr } = child.process
      const output = parallel ? Promise.all([TestRunner.#collect(stdout), TestRunner.#collect(stderr)]) : null
      const code = await child.exited
      if (output) {
        const text = (await output).join('')
        process.stdout.write(`${header}\n${text}${text.endsWith('\n') || !text ? '' : '\n'}`)
      }
      if (options.pattern !== undefined && E2e.unselected(marks)) {
        filtered.push(shown)
        console.log(`acdev test: ${shown}: no test matches -t ${JSON.stringify(options.pattern)}, skipped`)
        return
      }
      ran++
      const tally = TestRunner.tally(report)
      if (tally) tallies.push(tally)
      else uncounted.push(shown)
      if (code !== 0) {
        failed.push(shown)
        if (existsSync(settings.results)) kept.add(settings.results)
        if (options.bail) stop = true
      }
    }
    const worker = async (slot: number): Promise<void> => {
      while (!stop && next < suites.length) {
        const index = next++
        await one(suites[index]!, slot, index)
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, slot) => worker(slot)))
    if (!ran && filtered.length) {
      const files = `${filtered.length} file${filtered.length === 1 ? '' : 's'}`
      console.log(`acdev test: no test matches -t ${JSON.stringify(options.pattern)} in ${files}`)
      return 1
    }
    const unrun = suites.length - ran - filtered.length
    const summary = { tallies, uncounted, failed, files: ran, filtered: filtered.length, unrun }
    const left = kept.size ? `\n  what the failing tests left: ${[...kept].join(', ')}` : ''
    console.log(`${TestRunner.summary(summary, Color.palette())}${left}`)
    return failed.length ? 1 : 0
  }

  static #collect(stream: NodeJS.ReadableStream | null): Promise<string> {
    if (!stream) return Promise.resolve('')
    const chunks: Buffer[] = []
    return new Promise((resolve) => {
      stream.on('data', (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
  }

  static defaultWorkers(): number {
    return Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))
  }

  static #desktop(value: string, cwd: string): string {
    const path = /[\\/]/.test(value) || value === '.' || value === '..' || existsSync(resolve(cwd, value))
    return path ? resolve(cwd, value) : value
  }
}
