import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats,
} from 'node:fs'
import net from 'node:net'
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
  readonly test?: boolean
  readonly options?: Options
  readonly started: number
  readonly reloaded?: Reloaded
}

export interface Options {
  readonly desktop: string | null
  readonly app: string | null
}

export interface Wanted extends Options {
  readonly dirs: readonly string[]
  readonly headless: boolean
}

export interface Asked {
  readonly dirs?: readonly string[] | undefined
  readonly desktop?: string | undefined
  readonly app?: string | undefined
  readonly headless?: boolean | undefined
}

export interface Reloaded {
  readonly console: number
  readonly network: number
}

export class Sessions {
  static readonly SETTLE_MS = 1_000
  static readonly RETRY_MS = 50
  static readonly READS = 3
  static readonly PROBE_MS = 1_000
  static readonly TEST_ENV = 'ACDE_TEST_SESSION'

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
    const text = `${JSON.stringify(session, null, 2)}\n`
    if (Sessions.#rewrite(file, text)) return file
    const scratch = `${file}.${process.pid}.tmp`
    writeFileSync(scratch, text, { mode: 0o600 })
    for (let tries = 1; ; tries++) {
      try {
        renameSync(scratch, file)
        return file
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (tries >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          rmSync(scratch, { force: true })
          throw error
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
  }

  static #rewrite(file: string, text: string): boolean {
    if (!existsSync(file) || !Sessions.#plain(file, 'file')) return false
    let fd: number
    try {
      fd = openSync(file, 'r+')
    } catch {
      return false
    }
    try {
      const pad = Math.max(0, fstatSync(fd).size - Buffer.byteLength(text))
      const bytes = Buffer.from(`${text.slice(0, -1)}${' '.repeat(pad)}\n`)
      writeSync(fd, bytes, 0, bytes.length, 0)
      return true
    } finally {
      closeSync(fd)
    }
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

  static sameDir(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }

  static running(sessions: readonly Session[], dirs: readonly string[], self = process.pid): Session[] {
    return sessions.filter((session) => session.pid !== self && !session.test
      && session.dirs.some((dir) => dirs.some((mine) => Sessions.sameDir(dir, mine))))
  }

  static pathy(value: string): boolean {
    return /[\\/]/.test(value) || value === '.' || value === '..'
  }

  static desktopProject(value: string, cwd = process.cwd()): string | null {
    const dir = resolve(cwd, value)
    const project = statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true
      && ['package.json', ...CONFIGS].some((name) => existsSync(join(dir, name)))
    return project ? Sessions.#real(dir) : null
  }

  static desktopDir(value: string, cwd = process.cwd()): string | null {
    return Sessions.desktopProject(value, cwd) ?? (Sessions.pathy(value) ? Sessions.#real(resolve(cwd, value)) : null)
  }

  static wanted(cwd: string, asked: Asked): Wanted {
    const dirs = (asked.dirs?.length ? asked.dirs : ['.']).map((dir) => Sessions.#real(resolve(cwd, dir)))
    const desktopDir = asked.desktop === undefined ? null : Sessions.desktopDir(asked.desktop, cwd)
    return {
      dirs: desktopDir === null || dirs.some((dir) => Sessions.sameDir(dir, desktopDir)) ? dirs : [...dirs, desktopDir],
      desktop: desktopDir ?? asked.desktop ?? null,
      app: asked.app ?? null,
      headless: asked.headless === true,
    }
  }

  static runs(session: Session, wanted: Wanted): boolean {
    const options = session.options
    if (!options || options.app !== wanted.app || (session.headless === true) !== wanted.headless) return false
    const desktop = options.desktop === wanted.desktop
      || (options.desktop !== null && wanted.desktop !== null && Sessions.sameDir(options.desktop, wanted.desktop))
    const has = (dirs: readonly string[], dir: string) => dirs.some((other) => Sessions.sameDir(other, dir))
    return desktop && wanted.dirs.every((dir) => has(session.dirs, dir)) && session.dirs.every((dir) => has(wanted.dirs, dir))
  }

  static answers(endpoint: string, timeoutMs = Sessions.PROBE_MS): Promise<boolean> {
    return new Promise((done) => {
      const socket = net.connect(endpoint)
      const finish = (live: boolean) => {
        clearTimeout(timer)
        socket.destroy()
        done(live)
      }
      const timer = setTimeout(() => finish(true), timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('error', (error: NodeJS.ErrnoException) =>
        finish(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'))
    })
  }

  static async live(sessions: readonly Session[], dir = Sessions.dir()): Promise<Session[]> {
    const answered = await Promise.all(sessions.map((session) => Sessions.answers(session.endpoint)))
    const live = sessions.filter((_, at) => answered[at])
    for (const session of sessions) if (!live.includes(session)) Sessions.removeIfCurrent(session, dir)
    return live
  }

  static list(dir = Sessions.dir()): Session[] {
    return Sessions.scan(dir).sessions
  }

  static scan(dir = Sessions.dir()): { sessions: Session[]; busy: boolean } {
    if (!existsSync(dir) || !Sessions.#plain(dir, 'directory')) return { sessions: [], busy: false }
    const { names, writing } = Sessions.#names(dir)
    let busy = writing
    const found: Session[] = []
    for (const name of names) {
      const state = Sessions.#entry(dir, name)
      if (state === 'busy') busy = true
      else if (state) found.push(state)
    }
    Sessions.#sweep(dir)
    return { sessions: found.sort((a, b) => a.started - b.started), busy }
  }

  static #names(dir: string): { names: Set<string>; writing: boolean } {
    const names = new Set<string>()
    let writing = false
    for (const name of readdirSync(dir)) {
      names.add(name)
      const scratch = /^(\d+)\.json\.(\d+)\.tmp$/.exec(name)
      if (!scratch || !Sessions.alive(Number(scratch[2]))) continue
      writing = true
      names.add(`${scratch[1]}.json`)
    }
    return { names, writing }
  }

  static #entry(dir: string, name: string): Session | 'busy' | null {
    if (!/^\d+\.json$/.test(name)) return null
    const file = join(dir, name)
    if (!Sessions.#plain(file, 'file')) return null
    const pid = Number(name.slice(0, -'.json'.length))
    const session = Sessions.#settled(file)
    const alive = Sessions.alive(pid)
    if (session && session.pid === pid && alive) return session
    if (alive && session === null) return 'busy'
    rmSync(file, { force: true })
    return null
  }

  static #sweep(dir: string): void {
    for (const name of readdirSync(dir)) {
      const left = /^(?:(\d+)\.(?:[0-9a-z]+\.)?sock|\d+\.json\.(\d+)\.tmp|[0-9a-f]+\.claim\.(\d+)\.(?:tmp|aside))$/.exec(name)
      if (left && !Sessions.alive(Number(left[1] ?? left[2] ?? left[3]))) rmSync(join(dir, name), { force: true })
      else if (Claims.NAME.test(name)) Claims.sweep(join(dir, name))
    }
  }

  static async find(cwd: string, pid?: number, say?: (line: string) => void, dir = Sessions.dir()): Promise<Session> {
    const until = Date.now() + Sessions.SETTLE_MS
    for (;;) {
      const { sessions, busy } = Sessions.scan(dir)
      try {
        return Sessions.pick(sessions, cwd, pid, say, dir)
      } catch (error) {
        if (!busy || Date.now() >= until) throw error
      }
      await new Promise((done) => setTimeout(done, Sessions.RETRY_MS))
    }
  }

  static pick(
    listed: readonly Session[], cwd: string, pid?: number, say?: (line: string) => void, dir = Sessions.dir(),
  ): Session {
    if (pid !== undefined) {
      const chosen = listed.find((s) => s.pid === pid)
      if (chosen) return chosen
      throw new Error(`no acde dev with pid ${pid}${Sessions.#listing(listed)}`)
    }
    const sessions = listed.filter((s) => !s.test)
    if (sessions.length === 0 && listed.length > 0) {
      throw new Error('no acde dev is running, only sessions of acde test, which are reached only with --session <pid>'
        + Sessions.#listing(listed))
    }
    if (sessions.length === 0)
      throw new Error(`no acde dev is running (start one with acde dev; sessions are listed in ${dir})`)
    const here = Sessions.#real(cwd)
    const depth = (session: Session) =>
      Math.max(-1, ...session.dirs.filter((dir) => contains(dir, here)).map((dir) => dir.length))
    const deepest = Math.max(...sessions.map(depth))
    const matching = deepest < 0 ? [] : sessions.filter((s) => depth(s) === deepest)
    if (matching.length === 1) return matching[0]!
    const project = up(here, (dir) => [...CONFIGS, 'package.json'].some((name) => existsSync(join(dir, name))) && dir)
    if (matching.length === 0 && sessions.length === 1 && project === null) {
      const only = sessions[0]!
      say?.(`acde: using acde dev ${only.pid} (${Sessions.what(only)}), the only one running`)
      return only
    }
    if (matching.length === 0 && project !== null) {
      throw new Error(`no acde dev runs the project in ${project}; to use another one, pass --session <pid>`
        + Sessions.#listing(sessions))
    }
    const why = matching.length > 1
      ? `several acde dev sessions run ${here}`
      : `none of the ${sessions.length} acde dev sessions runs ${here}`
    throw new Error(`${why}; pick one with --session <pid>${Sessions.#listing(matching.length > 1 ? matching : sessions)}`)
  }

  static what(session: Session): string {
    const kind = session.desktop ? `desktop ${session.desktop}` : `app ${session.apps.join(', ')}`
    const notes = [session.headless && 'headless', session.test && 'acde test'].filter(Boolean)
    return `${kind}${notes.length ? ` (${notes.join(', ')})` : ''}`
  }

  static describe(session: Session): string {
    const what = Sessions.what(session)
    const since = new Date(session.started).toLocaleTimeString()
    return `${session.pid}  ${what}  ${session.dirs.join(', ')}  (since ${since})`
  }

  static #listing(sessions: readonly Session[]): string {
    return sessions.length ? `:\n${sessions.map((s) => `  ${Sessions.describe(s)}`).join('\n')}` : ''
  }

  static #settled(file: string): Session | null {
    for (let tries = 1; ; tries++) {
      const session = Sessions.#read(file)
      if (session || tries >= Sessions.READS) return session
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    }
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
        ...(json.test === true && { test: true }),
        ...Sessions.#options(json.options),
        started: Number(json.started) || 0,
        ...reloaded,
      }
    } catch {
      return null
    }
  }

  static #options(value: unknown): { options?: Options } {
    if (typeof value !== 'object' || value === null) return {}
    const { desktop, app } = value as Record<string, unknown>
    const fits = (field: unknown) => field === null || typeof field === 'string'
    return fits(desktop) && fits(app) ? { options: { desktop: desktop as string | null, app: app as string | null } } : {}
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
    const info = lstatSync(path, { throwIfNoEntry: false })
    if (info === undefined || info.isSymbolicLink()) return false
    return (kind === 'file' ? info.isFile() : info.isDirectory()) && Sessions.#owned(info)
  }
}

export interface Holder {
  readonly pid: number
  readonly dir: string
}

interface Claim {
  readonly pid: number
  readonly dir: string
  readonly beacon: string
}

export class Claims {
  static readonly NAME = /^[0-9a-f]{16}\.claim$/
  static readonly TRIES = 20

  static file(project: string, dir = Sessions.dir()): string {
    const key = process.platform === 'win32' ? project.toLowerCase() : project
    return join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.claim`)
  }

  static beacon(pid: number, started: number, dir = Sessions.dir()): string {
    const id = `${pid}.${started.toString(36)}`
    return process.platform === 'win32' ? `\\\\.\\pipe\\acde-dev-${id}` : join(dir, `${id}.sock`)
  }

  static async take(
    projects: readonly string[], started: number, dir = Sessions.dir(),
  ): Promise<Claims | Holder> {
    Sessions.prepare(dir)
    const beacon = Claims.beacon(process.pid, started, dir)
    const claims = new Claims(await Claims.#listen(beacon), beacon)
    const wanted = new Map(projects.map((project) => [Claims.file(project, dir), project]))
    try {
      for (const file of [...wanted.keys()].sort()) {
        const holder = await claims.#take(file, wanted.get(file)!)
        if (holder) {
          claims.release()
          return holder
        }
      }
    } catch (error) {
      claims.release()
      throw error
    }
    return claims
  }

  static sweep(file: string): void {
    const seen = Claims.#read(file)
    if (seen === null) return
    const claim = Claims.#parse(seen)
    if (!claim || !Sessions.alive(claim.pid)) Claims.#setAside(file, seen)
  }

  readonly #server: net.Server
  readonly #beacon: string
  readonly #held: [file: string, text: string][] = []

  private constructor(server: net.Server, beacon: string) {
    this.#server = server
    this.#beacon = beacon
  }

  release(): void {
    for (const [file, text] of this.#held.splice(0)) if (Claims.#read(file) === text) rmSync(file, { force: true })
    this.#server.close()
    if (process.platform !== 'win32') rmSync(this.#beacon, { force: true })
  }

  async #take(file: string, project: string): Promise<Holder | null> {
    const text = `${JSON.stringify({ pid: process.pid, dir: project, beacon: this.#beacon })}\n`
    const scratch = `${file}.${process.pid}.tmp`
    writeFileSync(scratch, text, { mode: 0o600 })
    try {
      for (let tries = 0; tries < Claims.TRIES; tries++) {
        try {
          linkSync(scratch, file)
          this.#held.push([file, text])
          return null
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const seen = Claims.#read(file)
        if (seen === null) continue
        const claim = Claims.#parse(seen)
        if (claim && Sessions.alive(claim.pid) && (await Sessions.answers(claim.beacon)))
          return { pid: claim.pid, dir: claim.dir }
        Claims.#setAside(file, seen)
      }
    } finally {
      rmSync(scratch, { force: true })
    }
    throw new Error(`${project}: could not claim it for this acde dev in ${Claims.TRIES} tries (${file} keeps changing); `
      + 'run it again, or pass --force')
  }

  static #listen(path: string): Promise<net.Server> {
    if (process.platform !== 'win32') rmSync(path, { force: true })
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.destroy())
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        server.unref()
        resolve(server)
      })
    })
  }

  static #setAside(file: string, seen: string): void {
    const aside = `${file}.${process.pid}.aside`
    try {
      renameSync(file, aside)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      if (Claims.#read(aside) !== seen) linkSync(aside, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      rmSync(aside, { force: true })
    }
  }

  static #read(file: string): string | null {
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  static #parse(text: string): Claim | null {
    try {
      const json = JSON.parse(text) as Partial<Claim>
      if (typeof json.pid !== 'number' || typeof json.dir !== 'string' || typeof json.beacon !== 'string') return null
      return { pid: json.pid, dir: json.dir, beacon: json.beacon }
    } catch {
      return null
    }
  }
}
