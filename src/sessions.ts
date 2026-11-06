import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface Session {
  readonly pid: number
  readonly endpoint: string
  readonly dirs: readonly string[]
  readonly apps: readonly string[]
  readonly desktop: string | null
  readonly started: number
}

export class Sessions {
  static dir(): string {
    return join(tmpdir(), 'acde-dev')
  }

  static file(pid: number, dir = Sessions.dir()): string {
    return join(dir, `${pid}.json`)
  }

  static write(session: Session, dir = Sessions.dir()): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!Sessions.#mine(dir)) throw new Error(`${dir} belongs to another user`)
    const file = Sessions.file(session.pid, dir)
    const scratch = `${file}.${process.pid}.tmp`
    writeFileSync(scratch, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
    renameSync(scratch, file)
    return file
  }

  static remove(pid: number, dir = Sessions.dir()): void {
    rmSync(Sessions.file(pid, dir), { force: true })
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
    if (!existsSync(dir) || !Sessions.#mine(dir)) return []
    const found: Session[] = []
    for (const name of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const file = join(dir, name)
      if (!Sessions.#mine(file)) continue
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
    if (sessions.length === 0) throw new Error(`no acde dev is running (start one with acde dev; sessions are listed in ${Sessions.dir()})`)
    const here = Sessions.#real(cwd)
    const depth = (session: Session) => Math.max(-1, ...session.dirs.filter((dir) => Sessions.contains(dir, here)).map((dir) => dir.length))
    const deepest = Math.max(...sessions.map(depth))
    const matching = deepest < 0 ? [] : sessions.filter((s) => depth(s) === deepest)
    if (matching.length === 1) return matching[0]!
    if (matching.length === 0 && sessions.length === 1) return sessions[0]!
    const why = matching.length > 1 ? `several acde dev sessions run ${here}` : `no acde dev runs ${here}, and there are several`
    throw new Error(`${why}; pick one with --session <pid>${Sessions.#listing(matching.length > 1 ? matching : sessions)}`)
  }

  static contains(dir: string, path: string): boolean {
    const rel = relative(dir, path)
    return rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..')
  }

  static describe(session: Session): string {
    const what = session.desktop ? `desktop ${session.desktop}` : `app ${session.apps.join(', ')}`
    return `${session.pid}  ${what}  ${session.dirs.join(', ')}  (since ${new Date(session.started).toLocaleTimeString()})`
  }

  static #listing(sessions: readonly Session[]): string {
    return sessions.length ? `:\n${sessions.map((s) => `  ${Sessions.describe(s)}`).join('\n')}` : ''
  }

  static #read(file: string): Session | null {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Partial<Session>
      if (typeof json.pid !== 'number' || typeof json.endpoint !== 'string' || !Array.isArray(json.dirs)) return null
      return { pid: json.pid, endpoint: json.endpoint, dirs: json.dirs, apps: Array.isArray(json.apps) ? json.apps : [], desktop: typeof json.desktop === 'string' ? json.desktop : null, started: Number(json.started) || 0 }
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

  static #mine(path: string): boolean {
    return process.platform === 'win32' || statSync(path).uid === process.getuid?.()
  }
}
