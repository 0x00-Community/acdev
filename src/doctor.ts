import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PermissionPrompt } from '@dopame/acde-api'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { BUN_MINIMUM, findAcdert, installed, NODE_MINIMUM, packageRoot, runtimes, which, type FoundAcdert } from 'acde/launcher'
import { Agents } from './agents.ts'
import { Project } from './app.ts'
import { Creator } from './create.ts'
import { DevSession, type RuntimeProbe } from './dev.ts'
import { Acde } from './driver/acde.ts'
import { AppPackage } from './package.ts'
import { up } from './paths.ts'
import { PackageManager } from './pm.ts'
import { Runtime } from './runtime.ts'
import { Sessions, type Session } from './sessions.ts'
import { Skills } from './skills.ts'
import { Versions } from './versions.ts'

export type Status = 'ok' | 'warn' | 'error' | 'skip'

export interface Check {
  readonly id: string
  readonly title: string
  readonly status: Status
  readonly summary: string
  readonly fix?: string
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
  ACDERT: 'from ACDERT',
  install: 'installed next to acde',
  PATH: 'on PATH',
}

export class Doctor {
  static readonly DIST = 'https://pkgs.dopame.ai/acde'
  static readonly HELP_MS = 10_000
  static readonly RUNTIME_MS = 60_000
  static readonly SESSION_MS = 3_000
  static readonly ONLINE_MS = 5_000
  static readonly ANSWER = 'acde allow (or acde deny): approving is the user\'s decision'
  static readonly PLATFORMS: Readonly<Record<string, string>> = { darwin: 'macos', win32: 'windows', linux: 'linux' }
  static readonly STATUSES: readonly Status[] = ['ok', 'warn', 'error', 'skip']

  static async run(options: DoctorOptions = {}): Promise<Check[]> {
    const found = findAcdert()
    const probe = found.path ? await DevSession.runtimeLevel(found.path) : null
    const runs = found.path !== null && probe !== null && probe.failed === null
    const available = runtimes()
    return [
      Doctor.acde(),
      Doctor.onPath(),
      Doctor.runtimes(available),
      Doctor.acdert(found, probe),
      runs ? Doctor.contract(probe) : Doctor.skip('contract', 'contract level', 'needs an acdert that runs'),
      ...(runs ? await Doctor.selfCheck(found.path!, probe) : [Doctor.skip('runtime', 'runtime check', 'needs an acdert that runs')]),
      ...(await Doctor.sessions()),
      ...Doctor.project(resolve(options.dir ?? '.'), options.dir !== undefined, available),
      Doctor.skill(),
      ...(options.online ? [await Doctor.latest()] : []),
    ]
  }

  static failed(checks: readonly Check[]): boolean {
    return checks.some((check) => check.status === 'error')
  }

  static format(checks: readonly Check[]): string {
    const lines: string[] = []
    for (const check of checks) {
      lines.push(`${check.status.padEnd(6)} ${check.title}: ${check.summary}`)
      if (check.fix) lines.push(`${''.padEnd(6)} fix: ${check.fix}`)
    }
    const count = (status: Status) => checks.filter((check) => check.status === status).length
    const [errors, warnings] = [count('error'), count('warn')]
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    if (errors > 0) lines.push(`acde doctor: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`)
    else if (warnings > 0) lines.push(`acde doctor: no errors, ${plural(warnings, 'warning')}`)
    else lines.push('acde doctor: everything acde needs is here')
    return lines.join('\n')
  }

  static json(checks: readonly Check[]): string {
    return JSON.stringify({ ok: !Doctor.failed(checks), checks }, null, 2)
  }

  static acde(): Check {
    const runtime = Runtime.bun ? `Bun ${process.versions['bun']}` : `Node.js ${process.versions.node}`
    return Doctor.ok('acde', 'acde', `${Versions.acde()} on ${runtime} (${Doctor.home()})`)
  }

  static onPath(env: NodeJS.ProcessEnv = process.env): Check {
    const home = Doctor.home()
    const found = which('acde', env)
    if (!found) return Doctor.warn('path', 'PATH', `no acde on PATH (this one is in ${home})`, Doctor.pathFix(home))
    if (Doctor.inside(Doctor.real(found), Doctor.real(home)))
      return Doctor.ok('path', 'PATH', `acde on PATH is this one (${found})`)
    return Doctor.warn('path', 'PATH', `acde on PATH is another one (${found}), not this one (${home})`,
      'remove the other acde from PATH, or put this one first')
  }

  static runtimes(available: Available): Check {
    const { bun, node } = available
    const bunText = bun ? `Bun ${BUN_MINIMUM.join('.')}+ at ${bun}` : `no Bun ${BUN_MINIMUM.join('.')}+ on PATH`
    const nodeText = node ? `Node.js ${NODE_MINIMUM.join('.')}+ at ${node}` : `no Node.js ${NODE_MINIMUM.join('.')}+ on PATH`
    const summary = `${bunText}; ${nodeText}`
    if (!bun) return Doctor.warn('runtimes', 'Bun and Node.js', `${summary}: acde test and projects that use bun need Bun`,
      'install Bun (https://bun.sh)')
    return Doctor.ok('runtimes', 'Bun and Node.js', summary)
  }

  static acdert(found: FoundAcdert, probe: RuntimeProbe | null): Check {
    if (!found.path || !probe) return Doctor.error('acdert', 'acdert', found.problem ?? 'not found', Doctor.acdertFix(found))
    const where = `${found.path} (${FROM[found.from!]})`
    if (probe.failed) return Doctor.error('acdert', 'acdert', `${where} does not run: ${probe.failed}`, Doctor.runFix(found, probe))
    if (probe.level === 0) {
      const told = probe.said ? `says ${JSON.stringify(probe.said)}` : 'printed nothing'
      return Doctor.error('acdert', 'acdert', `${where}: --version ${told}, no contract level: it is older than contract levels`,
        Doctor.acdertFix(found))
    }
    return Doctor.ok('acdert', 'acdert', `${probe.said.split(/\r?\n/)[0]} at ${where}`)
  }

  static contract(probe: RuntimeProbe): Check {
    const version = /^acdert (\S+) /.exec(probe.said)?.[1] ?? 'unknown'
    const sdk = Versions.sdk()
    const pairs = `acde ${Versions.acde()} is built with SDK ${sdk}, which pairs with acdert ${sdk}`
    if (probe.level !== API_LEVEL) {
      return Doctor.error('contract', 'contract level', `acde builds level ${API_LEVEL} apps, but acdert ${version} runs level ` +
        `${probe.level}: acde dev refuses to start it`, Doctor.pairFix(sdk))
    }
    if (version !== sdk) {
      return Doctor.warn('contract', 'contract level', `level ${API_LEVEL} on both sides, but ${pairs} and this one is ${version}`,
        Doctor.pairFix(sdk))
    }
    return Doctor.ok('contract', 'contract level', `level ${API_LEVEL} on both sides (acdert ${version}, SDK ${sdk})`)
  }

  static async selfCheck(acdert: string, probe: RuntimeProbe): Promise<Check[]> {
    const help = await Runtime.capture([acdert, '--help'], { timeout: Doctor.HELP_MS })
    if (!/^\s*acdert doctor\b/m.test(help.stdout)) {
      const version = /^acdert (\S+) /.exec(probe.said)?.[1] ?? 'unknown'
      const sdk = Versions.sdk()
      const fix = version === sdk ? 'use a newer build of acdert: this one was built before acdert doctor' : Doctor.pairFix(sdk)
      return [Doctor.warn('runtime', 'runtime check', `acdert ${version} cannot check itself (it has no acdert doctor), so its GPU ` +
        'and host files were not checked', fix)]
    }
    const ran = await Runtime.capture([acdert, 'doctor', '--json'], { timeout: Doctor.RUNTIME_MS })
    if (ran.timedOut)
      return [Doctor.error('runtime', 'runtime check', `acdert doctor did not finish within ${Doctor.RUNTIME_MS / 1000} s`)]
    let report: RuntimeReport
    try {
      report = JSON.parse(ran.stdout) as RuntimeReport
      if (!Array.isArray(report.checks)) throw new Error('no checks')
    } catch {
      const said = ran.error ?? (ran.stderr.trim().split(/\r?\n/).at(-1) || `exit code ${ran.code}`)
      return [Doctor.error('runtime', 'runtime check', `acdert doctor gave no report: ${said}`)]
    }
    return report.checks.map((check) => ({
      id: `runtime.${check.id}`,
      title: check.title,
      status: Doctor.STATUSES.includes(check.status) ? check.status : 'error',
      summary: check.summary,
      ...(check.fix && { fix: check.fix }),
    }))
  }

  static async sessions(): Promise<Check[]> {
    const dir = Sessions.dir()
    const problem = Sessions.problem(dir)
    if (problem) return [Doctor.error('sessions', 'acde dev sessions', problem, `remove ${dir}`)]
    const running = Sessions.list(dir)
    if (running.length === 0) return [Doctor.ok('sessions', 'acde dev sessions', 'none running')]
    const checks = [Doctor.ok('sessions', 'acde dev sessions', `${running.length} running: ` +
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
      return [Doctor.warn('sessions', 'acde dev sessions', `acde dev ${session.pid} does not answer: ${why}`, `acde stop --session ${session.pid}`)]
    }
    return prompts.map((prompt) => Doctor.warn('approval', 'approval', `${prompt.app} waits for approval of ${prompt.capability} ` +
      `in acde dev ${session.pid}, so it opens no window until the prompt is answered`, Doctor.ANSWER))
  }

  static project(dir: string, named: boolean, available: Available): Check[] {
    if (!Doctor.isProject(dir)) {
      const summary = `no acde project in ${dir} (no ${Project.CONFIGS[0]}, no acde field in package.json)`
      return [named ? Doctor.error('project', 'project', summary)
        : Doctor.skip('project', 'project', `${summary}: run acde doctor in a project, or pass its directory, to check it too`)]
    }
    const pkg = new AppPackage(dir)
    const checks = [Doctor.findings(pkg)]
    const platform = Doctor.PLATFORMS[process.platform]
    if (platform) checks.push(Doctor.platform(pkg, platform))
    const deps = Doctor.dependencies(dir, available)
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

  static findings(pkg: AppPackage): Check {
    let errors: readonly string[]
    let warnings: readonly string[]
    try {
      ;({ errors, warnings } = pkg.check())
    } catch (error) {
      errors = [error instanceof Error ? error.message : String(error)]
      warnings = []
    }
    const more = (list: readonly string[]) => (list.length > 1 ? ` (and ${list.length - 1} more)` : '')
    if (errors.length > 0) return Doctor.error('project', 'project', `${pkg.name}: ${errors[0]}${more(errors)}`, 'acde check lists them')
    if (warnings.length > 0) return Doctor.warn('project', 'project', `${pkg.name}: ${warnings[0]}${more(warnings)}`, 'acde check lists them')
    return Doctor.ok('project', 'project', `${pkg.name}, ${pkg.kind}: acde check finds nothing wrong`)
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

  static dependencies(dir: string, available: Available): Check | null {
    const manifest = Doctor.#json(join(dir, 'package.json'))
    if (!manifest) return null
    const pm = PackageManager.of(dir)
    const declared = { ...Doctor.#record(manifest['dependencies']), ...Doctor.#record(manifest['devDependencies']) }
    const runtime = pm.runtime === 'bun' ? `Bun ${BUN_MINIMUM.join('.')}+` : `Node.js ${NODE_MINIMUM.join('.')}+`
    if (!available[pm.runtime]) {
      return Doctor.warn('dependencies', 'dependencies', `this project uses ${pm.name}, so it runs on ${runtime}, which is not on ` +
        `PATH: acde builds it on ${Runtime.bun ? 'Bun' : 'Node.js'} instead`,
        pm.runtime === 'bun' ? 'install Bun (https://bun.sh)' : 'install Node.js (https://nodejs.org)')
    }
    const missing = Object.keys(declared).filter((name) => Doctor.installedPackage(dir, name) === null)
    if (missing.length > 0) {
      const named = missing.length > 3 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more` : missing.join(', ')
      return Doctor.warn('dependencies', 'dependencies', `not installed: ${named}`, `${pm.name} install`)
    }
    const sdk = Versions.sdk()
    const apiAt = Doctor.installedPackage(dir, '@dopame/acde-api')
    const api = apiAt === null ? null : Doctor.#json(apiAt)
    const theirs = typeof api?.['version'] === 'string' ? api['version'] : null
    if (theirs !== null && sdk !== 'unknown' && theirs !== sdk) {
      return Doctor.warn('dependencies', 'dependencies', `the project has @dopame/acde-api ${theirs}, this acde is built with ${sdk}`,
        `set @dopame/acde-api in package.json to ${Creator.api(dir)}, then ${pm.name} install`)
    }
    const sdkText = theirs ? `, @dopame/acde-api ${theirs}` : ''
    return Doctor.ok('dependencies', 'dependencies', `installed with ${pm.name} (runs on ${runtime})${sdkText}`)
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
    if (checked.status === 1) return Doctor.warn('gitignore', 'git', '.acde/ (the build output) is not ignored by git', 'add .acde/ to .gitignore')
    return null
  }

  static skill(): Check {
    if (!existsSync(join(Skills.SOURCE, 'SKILL.md')))
      return Doctor.warn('skill', 'agent skill', `the acde skill is not in this install (${Skills.SOURCE})`, 'install acde again')
    const source = Skills.stable()
    const seen = Skills.places(Agents.all()).map((place) => ({ place, state: Skills.look(source, place).state }))
    const placed = seen.filter(({ state }) => state === 'current' || state === 'outdated' || state === 'broken')
    if (placed.length === 0) return Doctor.warn('skill', 'agent skill', 'the acde skill is not installed for any coding agent', 'acde skills install')
    const stale = placed.filter(({ state }) => state !== 'current')
    if (stale.length > 0) {
      return Doctor.warn('skill', 'agent skill', stale.map(({ place, state }) => `${Skills.at(place)} is ${state}`).join('; '),
        'acde skills install')
    }
    return Doctor.ok('skill', 'agent skill', `current in ${placed.map(({ place }) => Skills.at(place)).join(', ')}`)
  }

  static async latest(env: NodeJS.ProcessEnv = process.env): Promise<Check> {
    const base = (env['ACDE_DIST'] || Doctor.DIST).replace(/\/+$/, '')
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
      return Doctor.warn('latest', 'latest release', `acde ${latest} is out; this is ${current}`, Doctor.installer(env))
    const relation = latest === current ? 'the latest release' : `newer than the latest release (${latest})`
    return Doctor.ok('latest', 'latest release', `acde ${current} is ${relation}`)
  }

  static installer(env: NodeJS.ProcessEnv = process.env): string {
    const base = (env['ACDE_DIST'] || Doctor.DIST).replace(/\/+$/, '')
    if (process.platform === 'win32') return `run the installer again: irm ${base}/install.ps1 | iex`
    return `run the installer again: curl -fsSL ${base}/install.sh | sh`
  }

  static home(): string {
    const root = packageRoot()
    return installed(root) ? resolve(root, '..', '..') : root
  }

  static acdertFix(found: FoundAcdert): string {
    if (found.from === 'ACDERT') return 'point ACDERT at an acdert binary, or unset it'
    if (installed(packageRoot())) return `${Doctor.installer()} (it puts the acdert that pairs with acde next to it)`
    return 'build acdert (cargo build --release -p acdert in an acdert checkout) and set ACDERT to its target/release/acdert, ' +
      'or put acdert on PATH'
  }

  static pairFix(sdk: string): string {
    if (installed(packageRoot())) return `${Doctor.installer()} (it installs the acdert that pairs with acde)`
    return `use acdert ${sdk}: set ACDERT to it, or put it on PATH`
  }

  static runFix(found: FoundAcdert, probe: RuntimeProbe): string {
    const path = found.path!
    if (process.platform === 'darwin' && Doctor.quarantined(path)) return `macOS keeps it in quarantine: xattr -d com.apple.quarantine ${path}`
    if (/error while loading shared libraries|cannot open shared object file/.test(probe.stderr))
      return 'install the system library named above, which acdert links against'
    return Doctor.acdertFix(found)
  }

  static quarantined(path: string): boolean {
    return spawnSync('xattr', ['-p', 'com.apple.quarantine', path], { stdio: 'ignore' }).status === 0
  }

  static pathFix(home: string): string {
    if (!installed(packageRoot())) return `bun link (in ${home}) puts this checkout's acde on PATH`
    const root = resolve(home, '..', '..')
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
