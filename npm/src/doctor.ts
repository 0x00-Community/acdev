import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { API_LEVEL } from './manifest/index.ts'
import {
  BUN_MINIMUM, cliFile, cliRuntime, findAcdert, installed, NODE_MINIMUM, packageRoot, runtimes, which, type FoundAcdert,
} from 'acdev/launcher'
import { Agents } from './agents.ts'
import { Color, type Palette } from './color.ts'
import { Project } from './app.ts'
import { Creator } from './create.ts'
import { DevSession, type RuntimeProbe } from './dev.ts'
import { Help } from './help.ts'
import type { PermissionPrompt } from './driver/acde.ts'
import { Sdk } from './sdk.ts'
import { Acde } from './driver/acde.ts'
import { AppPackage } from './package.ts'
import { up } from './paths.ts'
import { Pkgs } from './pkgs.ts'
import { PackageManager } from './pm.ts'
import { Runtime, type SpawnOptions } from './runtime.ts'
import { Sessions, type Session } from './sessions.ts'
import { Skills } from './skills.ts'
import { Versions } from './versions.ts'

export type Status = 'ok' | 'warn' | 'error' | 'skip'

export type RepairAction = 'reinstall' | 'sessions-dir' | 'stop' | 'dependencies' | 'skill' | 'gitignore'

export interface Repair {
  readonly action: RepairAction
  readonly target: string
  readonly ask: boolean
  readonly does: string
}

export interface Check {
  readonly id: string
  readonly title: string
  readonly status: Status
  readonly summary: string
  readonly fix?: string
  readonly repair?: Repair
}

export type Output = 'inherit' | 'stderr' | 'capture'

export interface Fixed {
  readonly repair: Repair
  readonly result: 'fixed' | 'failed' | 'skipped'
  readonly said: string
}

export interface FixOptions {
  readonly yes: boolean
  readonly output: Output
  readonly say: (line: string) => void
  readonly confirm: ((repair: Repair) => Promise<boolean>) | null
  readonly allowing: string
}

export interface DoctorOptions {
  readonly dir?: string
  readonly online?: boolean
}

interface RuntimeCheck {
  readonly id: string
  readonly title: string
  readonly status: Status
  readonly summary: string
  readonly fix: string | null
}

interface RuntimeReport {
  readonly checks: readonly RuntimeCheck[]
}

type Available = Readonly<Record<'bun' | 'node', string | null>>

const FROM: Readonly<Record<NonNullable<FoundAcdert['from']>, string>> = {
  ACDEV_RUNTIME: 'from ACDEV_RUNTIME',
  install: 'installed next to acdev',
}

export class Doctor {
  static readonly DIST = Pkgs.ACDE
  static readonly HELP_MS = 10_000
  static readonly RUNTIME_MS = 60_000
  static readonly SESSION_MS = 3_000
  static readonly ONLINE_MS = 5_000
  static readonly FETCH_MS = 30_000
  static readonly ACDE_MS = 60_000
  static readonly INSTALL_MS = 15 * 60_000
  static readonly KEEP_LINES = 20
  static readonly ANSWER = 'acdev allow (or acdev deny): approving is the user\'s decision'
  static readonly PLATFORMS: Readonly<Record<string, string>> = { darwin: 'macos', win32: 'windows', linux: 'linux' }
  static readonly STATUSES: readonly Status[] = ['ok', 'warn', 'error', 'skip']

  static async run(options: DoctorOptions = {}): Promise<Check[]> {
    const found = findAcdert()
    const probe = found.path ? await DevSession.runtimeLevel(found.path) : null
    const runs = found.path !== null && probe !== null && probe.failed === null
    const available = runtimes()
    const reinstall = Doctor.reinstallable(found) ? Doctor.reinstall() : null
    return [
      Doctor.acde(),
      Doctor.onPath(),
      Doctor.runtimes(available),
      Doctor.acdert(found, probe, reinstall),
      runs ? Doctor.contract(probe, reinstall)
        : Doctor.skip('contract', 'contract level', 'needs an acdev runtime that runs'),
      ...(runs ? await Doctor.selfCheck(found.path!, probe, reinstall)
        : [Doctor.skip('runtime', 'runtime check', 'needs an acdev runtime that runs')]),
      ...(await Doctor.sessions()),
      ...Doctor.project(resolve(options.dir ?? '.'), options.dir !== undefined, available),
      Doctor.skill(),
      ...(options.online ? [await Doctor.latest()] : []),
    ]
  }

  static failed(checks: readonly Check[]): boolean {
    return checks.some((check) => check.status === 'error')
  }

  static format(checks: readonly Check[], c: Palette = Color.palette(), width = Help.terminal()): string {
    const lines: string[] = []
    const paint = { ok: c.ok, warn: c.warn, error: c.error, skip: c.dim }
    const indent = ''.padEnd(7)
    for (const check of checks) {
      const status = `${paint[check.status](check.status.padEnd(6))} `
      lines.push(...Help.block(Help.unbroken(`${check.title}: ${check.summary}`), width, indent, status))
      if (check.fix) lines.push(`${indent}fix: ${check.fix}`)
    }
    const count = (status: Status) => checks.filter((check) => check.status === status).length
    const [errors, warnings] = [count('error'), count('warn')]
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const label = (errors > 0 ? c.error : warnings > 0 ? c.warn : c.ok)('acdev doctor:')
    if (errors > 0) lines.push(`${label} ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`)
    else if (warnings > 0) lines.push(`${label} no errors, ${plural(warnings, 'warning')}`)
    else lines.push(`${label} everything acdev needs is here`)
    return lines.join('\n')
  }

  static json(checks: readonly Check[], fixed?: readonly Fixed[]): string {
    return JSON.stringify({ ok: !Doctor.failed(checks), ...(fixed && { fixed }), checks }, null, 2)
  }

  static acde(): Check {
    const runtime = Runtime.bun ? `Bun ${process.versions['bun']}` : `Node.js ${process.versions.node}`
    return Doctor.ok('acdev', 'acdev', `${Versions.acde()} on ${runtime} (${Doctor.home()})`)
  }

  static onPath(env: NodeJS.ProcessEnv = process.env): Check {
    const home = Doctor.home()
    const found = which('acdev', env)
    if (!found) return Doctor.warn('path', 'PATH', `no acdev on PATH (this one is in ${home})`, Doctor.pathFix(home))
    if (Doctor.inside(Doctor.real(found), Doctor.real(home)) || Doctor.npmWrapper(found, home))
      return Doctor.ok('path', 'PATH', `acdev on PATH is this one (${found})`)
    return Doctor.warn('path', 'PATH', `acdev on PATH is another one (${found}), not this one (${home})`,
      'remove the other acdev from PATH, or put this one first')
  }

  static runtimes(available: Available): Check {
    const { bun, node } = available
    const bunText = bun ? `Bun ${BUN_MINIMUM.join('.')}+ at ${bun}` : `no Bun ${BUN_MINIMUM.join('.')}+ on PATH`
    const nodeText = node ? `Node.js ${NODE_MINIMUM.join('.')}+ at ${node}` : `no Node.js ${NODE_MINIMUM.join('.')}+ on PATH`
    const summary = `${bunText}; ${nodeText}`
    if (!bun) return Doctor.warn('runtimes', 'Bun and Node.js', `${summary}: acdev test and projects that use bun need Bun`,
      'install Bun (https://bun.sh)')
    return Doctor.ok('runtimes', 'Bun and Node.js', summary)
  }

  static acdert(found: FoundAcdert, probe: RuntimeProbe | null, reinstall: Repair | null = null): Check {
    if (!found.path || !probe)
      return Doctor.mend(Doctor.error('acdert', 'runtime', found.problem ?? 'not found', Doctor.acdertFix(found)),
        reinstall)
    const where = `${found.path} (${FROM[found.from!]})`
    if (probe.failed) {
      const fix = Doctor.runFix(found, probe)
      const quarantine = process.platform === 'darwin' && fix.startsWith('macOS keeps it in quarantine')
      const failing = Doctor.error('acdert', 'runtime', `${where} does not run: ${probe.failed}`, fix)
      return quarantine ? failing : Doctor.mend(failing, reinstall)
    }
    if (probe.level === 0) {
      const told = probe.said ? `says ${JSON.stringify(probe.said)}` : 'printed nothing'
      const summary = `${where}: --version ${told}, no contract level: it is older than contract levels`
      return Doctor.mend(Doctor.error('acdert', 'runtime', summary, Doctor.acdertFix(found)), reinstall)
    }
    return Doctor.ok('acdert', 'runtime', `${probe.said.split(/\r?\n/)[0]} at ${where}`)
  }

  static contract(probe: RuntimeProbe, reinstall: Repair | null = null): Check {
    const version = /^(?:acdev|acdert) (\S+) /.exec(probe.said)?.[1] ?? 'unknown'
    const sdk = Versions.sdk()
    const pairs = `acdev ${Versions.acde()} is built with SDK ${sdk}, which pairs with acdev runtime ${sdk}`
    if (probe.level !== API_LEVEL) {
      const summary = `acdev builds level ${API_LEVEL} apps, but acdev runtime ${version} runs ` +
        `level ${probe.level}: acdev dev refuses to start it`
      return Doctor.mend(Doctor.error('contract', 'contract level', summary, Doctor.pairFix(sdk)), reinstall)
    }
    if (version !== sdk) {
      return Doctor.mend(Doctor.warn('contract', 'contract level', `level ${API_LEVEL} on both sides, but ${pairs} and this one is ` +
        `${version}`, Doctor.pairFix(sdk)), reinstall)
    }
    return Doctor.ok('contract', 'contract level',
      `level ${API_LEVEL} on both sides (acdev runtime ${version}, SDK ${sdk})`)
  }

  static async selfCheck(acdert: string, probe: RuntimeProbe, reinstall: Repair | null = null): Promise<Check[]> {
    const help = await Runtime.capture([acdert, '--help'], { timeout: Doctor.HELP_MS })
    if (!/^\s*(?:acdev|acdert) doctor\b/m.test(help.stdout)) {
      const name = /^acdert /.test(probe.said) ? 'acdert' : 'acdev runtime'
      const version = /^(?:acdev|acdert) (\S+) /.exec(probe.said)?.[1] ?? 'unknown'
      const sdk = Versions.sdk()
      const fix = version === sdk ? `use a newer build of acdev runtime: this one was built before ${name} doctor`
        : Doctor.pairFix(sdk)
      const old = Doctor.warn('runtime', 'runtime check',
        `${name} ${version} cannot check itself (it has no ${name} doctor), so its GPU and host files were not ` +
        'checked', fix)
      return [version === sdk ? old : Doctor.mend(old, reinstall)]
    }
    const ran = await Runtime.capture([acdert, 'doctor', '--json'], { timeout: Doctor.RUNTIME_MS })
    if (ran.timedOut)
      return [Doctor.error('runtime', 'runtime check',
        `acdev runtime doctor did not finish within ${Doctor.RUNTIME_MS / 1000} s`)]
    let report: RuntimeReport
    try {
      report = JSON.parse(ran.stdout) as RuntimeReport
      if (!Array.isArray(report.checks)) throw new Error('no checks')
    } catch {
      const said = ran.error ?? (ran.stderr.trim().split(/\r?\n/).at(-1) || `exit code ${ran.code}`)
      return [Doctor.error('runtime', 'runtime check', `acdev runtime doctor gave no report: ${said}`)]
    }
    return report.checks.map((check) => {
      const mapped: Check = {
        id: `runtime.${check.id}`,
        title: check.title,
        status: Doctor.STATUSES.includes(check.status) ? check.status : 'error',
        summary: check.summary,
        ...(check.fix && { fix: check.fix }),
      }
      return check.id === 'host' ? Doctor.mend(mapped, reinstall) : mapped
    })
  }

  static async sessions(): Promise<Check[]> {
    const dir = Sessions.dir()
    const problem = Sessions.problem(dir)
    if (problem) {
      const info = lstatSync(dir)
      const replaceable = info.isSymbolicLink() || !info.isDirectory()
      const failing = Doctor.error('sessions', 'acdev dev sessions', problem, `remove ${dir}`)
      return [replaceable ? Doctor.mend(failing, { action: 'sessions-dir', target: dir, ask: false,
        does: `remove ${dir}, which is not a plain directory, and make it again` }) : failing]
    }
    const running = Sessions.list(dir)
    if (running.length === 0) return [Doctor.ok('sessions', 'acdev dev sessions', 'none running')]
    const checks = [Doctor.ok('sessions', 'acdev dev sessions', `${running.length} running: ` +
      running.map((session) => Sessions.describe(session)).join('; '))]
    for (const session of running) checks.push(...(await Doctor.waiting(session)))
    return checks
  }

  static async waiting(session: Session): Promise<Check[]> {
    let prompts: readonly PermissionPrompt[]
    try {
      prompts = await Doctor.#within(Doctor.#pending(session), Doctor.SESSION_MS)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      const stuck = Doctor.warn('sessions', 'acdev dev sessions', `acdev dev ${session.pid} does not answer: ${why}`,
        `acdev stop --session ${session.pid}`)
      return [Doctor.mend(stuck, { action: 'stop', target: String(session.pid), ask: true,
        does: `stop acdev dev ${session.pid}, which does not answer (acdev stop --session ${session.pid})` })]
    }
    return prompts.map((prompt) => Doctor.warn('approval', 'approval', `${prompt.app} waits for approval of ${prompt.capability} ` +
      `in acdev dev ${session.pid}, so its getUserMedia waits until the prompt is answered`, Doctor.ANSWER))
  }

  static project(dir: string, named: boolean, available: Available): Check[] {
    if (named && !existsSync(dir)) {
      return [Doctor.error('project', 'project', `${dir} does not exist: pass the directory of an acde project, `
        + 'or leave it out to check this machine only')]
    }
    if (!Doctor.isProject(dir)) {
      const summary = `no acde project in ${dir} (no ${Project.CONFIGS[0]}, no acde field in package.json)`
      return [named ? Doctor.error('project', 'project', summary)
        : Doctor.skip('project', 'project', `${summary}: run acdev doctor in a project, or pass its directory, to check it too`)]
    }
    const pkg = new AppPackage(dir)
    const fix = Doctor.sdkFix(dir, named)
    const deps = Doctor.dependencies(dir, available, fix)
    const checks = [Doctor.findings(pkg, deps?.fix === fix, fix)]
    const platform = Doctor.PLATFORMS[process.platform]
    if (platform) checks.push(Doctor.platform(pkg, platform))
    if (deps) checks.push(deps)
    const ignored = Doctor.ignored(dir)
    if (ignored) checks.push(ignored)
    return checks
  }

  static isProject(dir: string): boolean {
    if (Project.CONFIGS.some((name) => existsSync(join(dir, name)))) return true
    const manifest = Doctor.#json(join(dir, 'package.json'))
    return manifest !== null && typeof manifest['acde'] === 'object' && manifest['acde'] !== null
  }

  static findings(pkg: AppPackage, sdkElsewhere = false, sdkFix = Doctor.SDK_FIX): Check {
    let errors: readonly string[]
    let warnings: readonly string[]
    let sdk: string | null = null
    try {
      ;({ errors, warnings } = pkg.check())
      sdk = pkg.sdkWarning()
    } catch (error) {
      errors = [error instanceof Error ? error.message : String(error)]
      warnings = []
    }
    if (sdk !== null && sdkElsewhere) warnings = warnings.filter((warning) => warning !== sdk)
    else if (sdk !== null && errors.length === 0 && warnings.length === 1 && warnings[0] === sdk)
      return Doctor.warn('project', 'project', `${pkg.name}: ${sdk}`, sdkFix)
    const more = (list: readonly string[]) => (list.length > 1 ? ` (and ${list.length - 1} more)` : '')
    if (errors.length > 0) return Doctor.error('project', 'project', `${pkg.name}: ${errors[0]}${more(errors)}`, 'acdev check lists them')
    if (warnings.length > 0) return Doctor.warn('project', 'project', `${pkg.name}: ${warnings[0]}${more(warnings)}`, 'acdev check lists them')
    return Doctor.ok('project', 'project', `${pkg.name}, ${pkg.kind}: acdev check finds nothing wrong`)
  }

  static platform(pkg: AppPackage, platform: string): Check {
    let report: ReturnType<AppPackage['platform']>
    try {
      report = pkg.platform(platform)
    } catch (error) {
      return Doctor.skip('platform', 'platform', error instanceof Error ? error.message : String(error))
    }
    const notes = report.notes.length > 0 ? `; ${report.notes.join('; ')}` : ''
    if (report.errors.length > 0) {
      return Doctor.error('platform', 'platform', `${report.errors.join('; ')}${notes}`,
        'list the capability under optional in acde.config.jsonc, or run the app on a platform that has it')
    }
    return Doctor.ok('platform', 'platform', `${platform} (${report.modes.join(', ')}) has every required capability${notes}`)
  }

  static dependencies(dir: string, available: Available, sdkFix = Doctor.SDK_FIX): Check | null {
    const manifest = Doctor.#json(join(dir, 'package.json'))
    if (!manifest) return null
    let pm: PackageManager
    try {
      pm = PackageManager.of(dir)
    } catch (error) {
      return Doctor.error('dependencies', 'dependencies', error instanceof Error ? error.message : String(error),
        'make that package.json valid JSON')
    }
    const declared = { ...Doctor.#record(manifest['dependencies']), ...Doctor.#record(manifest['devDependencies']) }
    const runtime = pm.runtime === 'bun' ? `Bun ${BUN_MINIMUM.join('.')}+` : `Node.js ${NODE_MINIMUM.join('.')}+`
    if (!available[pm.runtime]) {
      return Doctor.warn('dependencies', 'dependencies', `this project uses ${pm.name}, so it runs on ${runtime}, which is not on ` +
        `PATH: acdev builds it on ${Runtime.bun ? 'Bun' : 'Node.js'} instead`,
        pm.runtime === 'bun' ? 'install Bun (https://bun.sh)' : 'install Node.js (https://nodejs.org)')
    }
    const sdkCheck = Doctor.#sdk(dir, manifest, sdkFix)
    if (sdkCheck) return sdkCheck
    const missing = Object.keys(declared).filter((name) => Doctor.installedPackage(dir, name) === null)
    if (missing.length > 0) {
      const named = missing.length > 3 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more` : missing.join(', ')
      return Doctor.mend(Doctor.warn('dependencies', 'dependencies', `not installed: ${named}`, `${pm.name} install`),
        { action: 'dependencies', target: dir, ask: true, does: `install the project's dependencies (${pm.name} install in ${dir})` })
    }
    const apiAt = Doctor.installedPackage(dir, '@dopame/acde-api')
    const api = apiAt === null ? null : Doctor.#json(apiAt)
    const theirs = typeof api?.['version'] === 'string' ? api['version'] : null
    const sdkText = theirs ? `, @dopame/acde-api ${theirs}` : ''
    return Doctor.ok('dependencies', 'dependencies', `installed with ${pm.name} (runs on ${runtime})${sdkText}`)
  }

  static #sdk(dir: string, manifest: Readonly<Record<string, unknown>>, fix: string): Check | null {
    const sdk = Versions.sdk()
    if (sdk === 'unknown') return null
    const state = Sdk.state(dir, manifest)
    if (state.spec === null) return null
    const apiAt = Doctor.installedPackage(dir, Sdk.NAME)
    const api = apiAt === null ? null : Doctor.#json(apiAt)
    const installed = typeof api?.['version'] === 'string' ? api['version'] : null
    const named = state.version
    if ((named === null || named === sdk) && (installed === null || installed === sdk)) return null
    const has = named !== null && installed !== null && named !== installed
      ? `package.json names ${named}, ${installed} is installed`
      : `the project has ${installed ?? named ?? state.spec}`
    return Doctor.warn('dependencies', 'dependencies', `${Sdk.NAME}: ${has}; this acdev pairs with ${sdk} `
      + `(acdev sdk update sets it to ${Sdk.spec()} and reinstalls)`, fix)
  }

  static installedPackage(dir: string, name: string): string | null {
    return up(dir, (at) => {
      const file = join(at, 'node_modules', name, 'package.json')
      return existsSync(file) ? file : null
    })
  }

  static ignored(dir: string): Check | null {
    const git = which('git')
    if (!git) return null
    const inside = spawnSync(git, ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' })
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null
    const checked = spawnSync(git, ['check-ignore', '-q', '.acde/'], { cwd: dir })
    if (checked.status === 0) return Doctor.ok('gitignore', 'git', '.acde/ (the build output) is ignored')
    if (checked.status === 1) {
      return Doctor.mend(Doctor.warn('gitignore', 'git', '.acde/ (the build output) is not ignored by git', 'add .acde/ to .gitignore'),
        { action: 'gitignore', target: dir, ask: false, does: `add .acde/ to ${join(dir, '.gitignore')}` })
    }
    return null
  }

  static skill(): Check {
    if (!existsSync(join(Skills.SOURCE, 'SKILL.md')))
      return Doctor.warn('skill', 'agent skill', `the acdev skill is not in this install (${Skills.SOURCE})`, 'install acdev again')
    const source = Skills.stable()
    const seen = Skills.places(Agents.all()).map((place) => ({ place, state: Skills.look(source, place).state }))
    const placed = seen.filter(({ state }) => state === 'current' || state === 'outdated' || state === 'broken')
    const install: Repair = { action: 'skill', target: '', ask: false,
      does: 'install the acdev skill for the coding agents found here (acdev skills install)' }
    if (placed.length === 0) {
      return Doctor.mend(Doctor.warn('skill', 'agent skill', 'the acdev skill is not installed for any coding agent',
        'acdev skills install'), install)
    }
    const stale = placed.filter(({ state }) => state !== 'current')
    if (stale.length > 0) {
      return Doctor.mend(Doctor.warn('skill', 'agent skill', stale.map(({ place, state }) => `${Skills.at(place)} is ${state}`)
        .join('; '), 'acdev skills install'), install)
    }
    return Doctor.ok('skill', 'agent skill', `current in ${placed.map(({ place }) => Skills.at(place)).join(', ')}`)
  }

  static async latest(env: NodeJS.ProcessEnv = process.env): Promise<Check> {
    const base = (env['ACDEV_DIST'] || Doctor.DIST).replace(/\/+$/, '')
    const current = Versions.acde()
    let latest: string
    try {
      const response = await fetch(`${base}/latest`, { signal: AbortSignal.timeout(Doctor.ONLINE_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      latest = (await response.text()).trim()
      if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`it says ${JSON.stringify(latest.slice(0, 40))}, not a version`)
    } catch (error) {
      return Doctor.warn('latest', 'latest release', `could not read ${base}/latest: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Versions.newer(latest, current))
      return Doctor.warn('latest', 'latest release', `acdev ${latest} is out; this is ${current}`, Doctor.installer(env))
    const relation = latest === current ? 'the latest release' : `newer than the latest release (${latest})`
    return Doctor.ok('latest', 'latest release', `acdev ${current} is ${relation}`)
  }

  static fromNpm(home: string = Doctor.home()): boolean {
    return basename(dirname(home)) === '@dopame' && basename(home).startsWith('acdev-')
  }

  static npmWrapper(found: string, home: string): boolean {
    const file = Doctor.real(found)
    if (basename(file) !== 'acdev.mjs' || !Doctor.fromNpm(home)) return false
    try {
      const resolved = createRequire(file).resolve(`${basename(dirname(home))}/${basename(home)}/package.json`)
      return Doctor.real(dirname(resolved)) === Doctor.real(home)
    } catch {
      return false
    }
  }

  static installer(env: NodeJS.ProcessEnv = process.env, version?: string): string {
    if (Doctor.fromNpm()) return `install it again from npm: npm install -g @dopame/acdev${version ? `@${version}` : ''}`
    const base = (env['ACDEV_DIST'] || Doctor.DIST).replace(/\/+$/, '')
    if (process.platform === 'win32') return `run the installer again: irm ${base}/install.ps1 | iex`
    return `run the installer again: curl -fsSL ${base}/install.sh | sh`
  }

  static reinstallable(found: FoundAcdert): boolean {
    return installed(packageRoot()) && !Doctor.fromNpm() && found.from !== 'ACDEV_RUNTIME'
  }

  static reinstall(env: NodeJS.ProcessEnv = process.env): Repair {
    const version = Versions.acde()
    const script = process.platform === 'win32' ? 'install.ps1' : 'install.sh'
    return {
      action: 'reinstall',
      target: version,
      ask: true,
      does: `run the installer of acdev ${version} again (${Doctor.dist(env)}/${script}), which downloads the acdev runtime ` +
        `released with it, checks it against SHA256SUMS and puts it next to acdev`,
    }
  }

  static dist(env: NodeJS.ProcessEnv = process.env): string {
    return (env['ACDEV_DIST'] || Doctor.DIST).replace(/\/+$/, '')
  }

  static installRoot(): string {
    return resolve(Doctor.home(), '..', '..')
  }

  static mend(check: Check, repair: Repair | null): Check {
    return repair ? { ...check, repair } : check
  }

  static repairs(checks: readonly Check[]): Repair[] {
    const seen = new Map<string, Repair>()
    for (const check of checks) {
      if (!check.repair || (check.status !== 'warn' && check.status !== 'error')) continue
      const key = `${check.repair.action}:${check.repair.target}`
      if (!seen.has(key)) seen.set(key, check.repair)
    }
    return [...seen.values()]
  }

  static async fix(checks: readonly Check[], options: FixOptions): Promise<Fixed[]> {
    const repairs = Doctor.repairs(checks)
    if (repairs.length === 0) {
      options.say('acdev doctor: nothing here it can fix; the fix lines say what to do')
      return []
    }
    const done: Fixed[] = []
    for (const repair of repairs) {
      if (repair.ask && !options.yes) {
        const agreed = options.confirm ? await options.confirm(repair) : false
        if (!agreed) {
          const how = options.confirm ? '' : ` (it asks first: ${options.allowing})`
          options.say(`skipped: ${repair.does}${how}`)
          done.push({ repair, result: 'skipped', said: '' })
          continue
        }
      }
      options.say(`fixing: ${repair.does}`)
      try {
        const said = await Doctor.apply(repair, options.output)
        if (said) options.say(said)
        options.say(`fixed: ${repair.does}`)
        done.push({ repair, result: 'fixed', said })
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        options.say(`failed: ${repair.does}: ${why}`)
        done.push({ repair, result: 'failed', said: why })
      }
    }
    return done
  }

  static async apply(repair: Repair, output: Output): Promise<string> {
    switch (repair.action) {
      case 'skill':
        return await Doctor.#run([cliRuntime(), cliFile(), 'skills', 'install'], {}, output, Doctor.ACDE_MS)
      case 'stop':
        return await Doctor.#run([cliRuntime(), cliFile(), 'stop', '--session', repair.target], {}, output, Doctor.ACDE_MS)
      case 'gitignore':
        return `added .acde/ to ${Creator.ignoreBuild(repair.target)}`
      case 'sessions-dir':
        rmSync(repair.target, { force: true })
        Sessions.prepare(repair.target)
        return `made ${repair.target} again`
      case 'dependencies':
        return await Doctor.#run(PackageManager.of(repair.target).install, { cwd: repair.target }, output, Doctor.INSTALL_MS)
      case 'reinstall':
        return await Doctor.#reinstall(repair.target, output)
    }
  }

  static async #reinstall(version: string, output: Output): Promise<string> {
    const windows = process.platform === 'win32'
    const script = windows ? 'install.ps1' : 'install.sh'
    const url = `${Doctor.dist()}/${script}`
    const response = await fetch(url, { signal: AbortSignal.timeout(Doctor.FETCH_MS) })
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    const dir = mkdtempSync(join(tmpdir(), 'acde-doctor-'))
    try {
      const file = join(dir, script)
      writeFileSync(file, await response.text())
      const argv = windows
        ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Version', version, '-NoModifyPath']
        : ['sh', file, '--version', version, '--no-modify-path']
      return await Doctor.#run(argv, { env: { ...process.env, ACDEV_INSTALL: Doctor.installRoot() } }, output, Doctor.INSTALL_MS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  static async #run(argv: readonly string[], options: SpawnOptions, output: Output, timeout: number): Promise<string> {
    const shown = argv.slice(argv[1] === cliFile() ? 2 : 0).join(' ')
    if (output === 'capture') {
      const ran = await Runtime.capture(argv, { ...options, timeout })
      const said = `${ran.stdout}${ran.stderr}`.trim().split(/\r?\n/).slice(-Doctor.KEEP_LINES).join('\n')
      if (ran.error) throw new Error(ran.error)
      if (ran.timedOut) throw new Error(`${shown} did not finish within ${timeout / 1000} s`)
      if (ran.code !== 0) throw new Error(`${shown} exited with code ${ran.code}${said ? `:\n${said}` : ''}`)
      return said
    }
    const child = Runtime.spawn(argv, { ...options, stdio: ['ignore', output === 'inherit' ? 'inherit' : 2, 'inherit'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    try {
      const code = await child.exited
      if (code !== 0) throw new Error(`${shown} exited with code ${code}`)
      return ''
    } finally {
      clearTimeout(timer)
    }
  }

  static home(): string {
    const root = packageRoot()
    return installed(root) ? resolve(root, '..', '..') : root
  }

  static acdertFix(found: FoundAcdert): string {
    if (found.from === 'ACDEV_RUNTIME') return 'point ACDEV_RUNTIME at the runtime binary, or unset it'
    if (installed(packageRoot()))
      return `${Doctor.installer(process.env, Versions.acde())} ` +
        '(it puts the acdev runtime that pairs with acdev next to it)'
    return 'build the runtime (cargo build --release -p acdev in an acdev checkout) and set ACDEV_RUNTIME '
      + 'to its target/release/acdev'
  }

  static pairFix(sdk: string): string {
    if (installed(packageRoot()))
      return `${Doctor.installer(process.env, Versions.acde())} (it installs the acdev runtime that pairs with acdev)`
    return `use the runtime ${sdk}: set ACDEV_RUNTIME to it`
  }

  static runFix(found: FoundAcdert, probe: RuntimeProbe): string {
    const path = found.path!
    if (process.platform === 'darwin' && Doctor.quarantined(path)) return `macOS keeps it in quarantine: xattr -d com.apple.quarantine ${path}`
    if (/error while loading shared libraries|cannot open shared object file/.test(probe.stderr))
      return 'install the system library named above, which acdev runtime links against'
    return Doctor.acdertFix(found)
  }

  static quarantined(path: string): boolean {
    return spawnSync('xattr', ['-p', 'com.apple.quarantine', path], { stdio: 'ignore' }).status === 0
  }

  static pathFix(home: string): string {
    if (!installed(packageRoot())) return `bun link (in ${home}) puts this checkout's acdev on PATH`
    if (Doctor.fromNpm()) return 'add the bin directory of npm\'s global prefix (npm prefix -g) to PATH'
    const root = Doctor.installRoot()
    const bin = process.platform === 'win32' ? join(root, 'current', 'bin') : join(root, 'bin')
    return `add ${bin} to PATH (the installer does that unless it is told not to)`
  }

  static inside(path: string, dir: string): boolean {
    const rel = relative(dir, path)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  static real(path: string): string {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }

  static ok(id: string, title: string, summary: string): Check {
    return { id, title, status: 'ok', summary }
  }

  static readonly SDK_FIX = 'run acdev sdk update'

  static sdkFix(dir: string, named: boolean, cwd = process.cwd()): string {
    const [at, here] = [Doctor.real(dir), Doctor.real(cwd)]
    if (!named || at === here) return Doctor.SDK_FIX
    const shown = Doctor.inside(at, here) ? relative(here, at) : at
    return `${Doctor.SDK_FIX} ${/\s/.test(shown) ? `"${shown}"` : shown}`
  }

  static warn(id: string, title: string, summary: string, fix?: string): Check {
    return { id, title, status: 'warn', summary, ...(fix && { fix }) }
  }

  static error(id: string, title: string, summary: string, fix?: string): Check {
    return { id, title, status: 'error', summary, ...(fix && { fix }) }
  }

  static skip(id: string, title: string, summary: string): Check {
    return { id, title, status: 'skip', summary }
  }

  static async #pending(session: Session): Promise<readonly PermissionPrompt[]> {
    const acde = await Acde.attach({ session: session.pid, timeout: Doctor.SESSION_MS })
    try {
      return (await acde.permissions()).pending
    } finally {
      await acde.close()
    }
  }

  static async #within<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms)
    })
    try {
      return await Promise.race([work, late])
    } finally {
      clearTimeout(timer)
    }
  }

  static #json(file: string): Record<string, unknown> | null {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  static #record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  }
}
