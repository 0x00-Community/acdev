import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  writeFileSync, type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { CONFIGS } from './configs.ts'
import { contains, up } from './paths.ts'

export interface Session {
  readonly pid: number
  readonly endpoint: string
  readonly dirs: readonly string[]
  readonly apps: readonly string[]
  readonly desktop: string | null
  readonly headless?: boolean
  readonly started: number
  readonly reloaded?: Reloaded
}

export interface Reloaded {
  readonly console: number
  readonly network: number
}

export class Sessions {
  static dir(env: NodeJS.ProcessEnv = process.env): string {
    const runtime = env['XDG_RUNTIME_DIR']
    if (runtime && isAbsolute(runtime)) return join(runtime, 'acde-dev')
    const uid = process.getuid?.()
    const tmp = env['TMPDIR'] && isAbsolute(env['TMPDIR']) ? env['TMPDIR'].replace(/(.)[\\/]+$/, '$1') : tmpdir()
    return join(tmp, uid === undefined ? 'acde-dev' : `acde-dev-${uid}`)
  }

  static file(pid: number, dir = Sessions.dir()): string {
    return join(dir, `${pid}.json`)
  }

  static prepare(dir = Sessions.dir()): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') return dir
    const problem = Sessions.problem(dir)
    if (problem) throw new Error(problem)
    if ((lstatSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
    return dir
  }

  static problem(dir = Sessions.dir()): string | null {
    if (process.platform === 'win32') return null
    const info = lstatSync(dir, { throwIfNoEntry: false })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isDirectory()) return `${dir} is not a plain directory; remove it and run again`
    if (!Sessions.#owned(info)) return `${dir} belongs to another user`
    return null
  }

  static socket(pid: number, dir = Sessions.dir()): string {
    return join(dir, `${pid}.sock`)
  }

  static write(session: Session, dir = Sessions.dir()): string {
    Sessions.prepare(dir)
    const file = Sessions.file(session.pid, dir)
    const scratch = `${file}.${process.pid}.tmp`
    writeFileSync(scratch, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
    renameSync(scratch, file)
    return file
  }

  static remove(pid: number, dir = Sessions.dir()): void {
    rmSync(Sessions.file(pid, dir), { force: true })
  }

  static removeIfCurrent(session: Session, dir: string): void {
    const current = Sessions.#read(Sessions.file(session.pid, dir))
    const same = current?.pid === session.pid && current.started === session.started
    if (same && current?.endpoint === session.endpoint) Sessions.remove(session.pid, dir)
  }

  static alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  static list(dir = Sessions.dir()): Session[] {
    if (!existsSync(dir) || !Sessions.#plain(dir, 'directory')) return []
    const found: Session[] = []
    for (const name of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const file = join(dir, name)
      if (!Sessions.#plain(file, 'file')) continue
      const session = Sessions.#read(file)
      if (session && Sessions.alive(session.pid)) found.push(session)
      else rmSync(file, { force: true })
    }
    return found.sort((a, b) => a.started - b.started)
  }

  static pick(sessions: readonly Session[], cwd: string, pid?: number): Session {
    if (pid !== undefined) {
      const chosen = sessions.find((s) => s.pid === pid)
      if (chosen) return chosen
      throw new Error(`no acde dev with pid ${pid}${Sessions.#listing(sessions)}`)
    }
    if (sessions.length === 0)
      throw new Error(`no acde dev is running (start one with acde dev; sessions are listed in ${Sessions.dir()})`)
    const here = Sessions.#real(cwd)
    const depth = (session: Session) =>
      Math.max(-1, ...session.dirs.filter((dir) => contains(dir, here)).map((dir) => dir.length))
    const deepest = Math.max(...sessions.map(depth))
    const matching = deepest < 0 ? [] : sessions.filter((s) => depth(s) === deepest)
    if (matching.length === 1) return matching[0]!
    const project = up(here, (dir) => [...CONFIGS, 'package.json'].some((name) => existsSync(join(dir, name))) && dir)
    if (matching.length === 0 && sessions.length === 1 && project === null) return sessions[0]!
    if (matching.length === 0 && project !== null) {
      throw new Error(`no acde dev runs the project in ${project}; to use another one, pass --session <pid>`
        + Sessions.#listing(sessions))
    }
    const why = matching.length > 1
      ? `several acde dev sessions run ${here}`
      : `no acde dev runs ${here}, and there are several`
    const listed = Sessions.#listing(matching.length > 1 ? matching : sessions)
    throw new Error(`${why}; pick one with --session <pid>${listed}`)
  }

  static describe(session: Session): string {
    const kind = session.desktop ? `desktop ${session.desktop}` : `app ${session.apps.join(', ')}`
    const what = `${kind}${session.headless ? ' (headless)' : ''}`
    const since = new Date(session.started).toLocaleTimeString()
    return `${session.pid}  ${what}  ${session.dirs.join(', ')}  (since ${since})`
  }

  static #listing(sessions: readonly Session[]): string {
    return sessions.length ? `:\n${sessions.map((s) => `  ${Sessions.describe(s)}`).join('\n')}` : ''
  }

  static #read(file: string): Session | null {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Partial<Session>
      if (typeof json.pid !== 'number' || typeof json.endpoint !== 'string' || !Array.isArray(json.dirs)) return null
      const marks = json.reloaded
      const reloaded = typeof marks?.console === 'number' && typeof marks.network === 'number'
        ? { reloaded: { console: marks.console, network: marks.network } }
        : {}
      return {
        pid: json.pid,
        endpoint: json.endpoint,
        dirs: json.dirs,
        apps: Array.isArray(json.apps) ? json.apps : [],
        desktop: typeof json.desktop === 'string' ? json.desktop : null,
        headless: json.headless === true,
        started: Number(json.started) || 0,
        ...reloaded,
      }
    } catch {
      return null
    }
  }

  static #real(path: string): string {
    try {
      return realpathSync(resolve(path))
    } catch {
      return resolve(path)
    }
  }

  static #owned(info: Stats): boolean {
    return process.platform === 'win32' || info.uid === process.getuid?.()
  }

  static #plain(path: string, kind: 'file' | 'directory'): boolean {
    if (process.platform === 'win32') return true
    const info = lstatSync(path)
    return !info.isSymbolicLink() && (kind === 'file' ? info.isFile() : info.isDirectory()) && Sessions.#owned(info)
  }
}
