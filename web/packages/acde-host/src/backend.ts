import type { AppManifest } from './apps'
import { Crashes } from './crashes'
import { PageSource } from './page'
import { mkdirSync, readdirSync, rmSync, stat } from './sys/fs'
import { sys } from './sys/natives'
import { runtimeDir, xdgHome } from './sys/os'
import { dirname, join } from './sys/path'
import { process, stopGroup, type Env } from './sys/process'
import { unref } from './sys/timers'
import { Level, Log } from './log'

interface Running {
  readonly app: AppManifest
  readonly sockets: string
  pid: number | null
  stopping: boolean
  ended: Promise<void>
  end: () => void
}

interface AppBackendsOptions {
  readonly resources: () => { prefix: string; dirs: string[] }[]
  readonly wanted: (id: string) => boolean
  readonly env?: Env
  readonly report?: (line: string) => void
}

export class AppBackends {
  static readonly RESTARTS = 3
  static readonly STOP_MS = 3000
  static readonly ENV = ['HOME', 'USER', 'PATH', 'LANG', 'LANGUAGE', 'TZ', 'XDG_RUNTIME_DIR']

  readonly #options: AppBackendsOptions
  readonly #report: (line: string) => void
  readonly #running = new Map<string, Running>()
  readonly #crashes = new Crashes(AppBackends.RESTARTS)
  readonly #failed = new Set<string>()

  constructor(options: AppBackendsOptions) {
    this.#options = options
    this.#report = options.report ?? ((line) => Log.write(Level.Info, 'acde_host', line))
  }

  get #env(): Env {
    return this.#options.env ?? process.env
  }

  static socketDir(id: string, env: Env = process.env): string {
    return join(runtimeDir(env), 'acde', 'apps', id)
  }

  static dataDir(id: string, env: Env = process.env): string {
    return join(xdgHome('data', env), 'acde', 'apps', id)
  }

  start(app: AppManifest): boolean {
    if (!app.backend) return false
    if (this.#running.has(app.id)) return true
    if (this.#failed.has(app.id)) return false
    const sockets = AppBackends.socketDir(app.id, this.#env)
    try {
      mkdirSync(sockets, { recursive: true, mode: 0o700 })
      mkdirSync(AppBackends.dataDir(app.id, this.#env), { recursive: true })
    } catch (error) {
      this.#report(`acde-host: [${app.id}#backend] ${(error as Error).message}`)
      return false
    }
    for (const name of AppBackends.#list(sockets)) if (name.endsWith('.sock')) rmSync(join(sockets, name), { force: true })
    const running: Running = { app, sockets, pid: null, stopping: false, ended: Promise.resolve(), end: () => undefined }
    this.#running.set(app.id, running)
    if (this.#spawn(running)) return true
    this.#running.delete(app.id)
    return false
  }

  #spawn(running: Running): boolean {
    const { app } = running
    const name = `${app.id}#backend`
    const server = PageSource.file(app.backend!.entry, this.#options.resources())
    const preload = server && join(dirname(server), 'acde-listen.js')
    if (!server || !stat(preload!)?.isFile) {
      this.#report(`acde-host: [${name}] not started: ${server ? `no acde-listen.js beside ${server} (built by an older acde-app: build it again)` : `no file for ${app.backend!.entry}`}`)
      return false
    }
    const spawn = sys().spawn
    if (!spawn) {
      this.#report(`acde-host: [${name}] not started: this acde cannot start processes (not Linux)`)
      return false
    }
    const session = this.#env
    const data = AppBackends.dataDir(app.id, session)
    const env: Record<string, string> = {}
    for (const key of AppBackends.ENV) if (session[key]) env[key] = session[key]!
    Object.assign(env, { ACDE_APP_ID: app.id, ACDE_APP_DATA: data, ACDE_APP_SOCKETS: running.sockets, PORT: String(app.backend!.port), NODE_ENV: 'production' })
    running.ended = new Promise((done) => (running.end = done))
    try {
      running.pid = spawn(['bun', '--preload', preload!, server], { cwd: data, env, prefix: `[${name}] ` }, (code, signal) => this.#exited(running, code, signal))
    } catch (error) {
      running.end()
      this.#report(`acde-host: [${name}] not started: ${(error as Error).message}`)
      return false
    }
    this.#report(`acde-host: [${name}] started (pid ${running.pid}, port ${app.backend!.port})`)
    return true
  }

  #exited(running: Running, code: number | null, signal: number | null): void {
    running.pid = null
    running.end()
    const { app } = running
    const name = `${app.id}#backend`
    if (running.stopping || this.#running.get(app.id) !== running) return
    const why = signal === null ? `exit ${code}` : `signal ${signal}`
    const crashes = this.#crashes.note(app.id)
    if (!this.#options.wanted(app.id)) {
      this.#running.delete(app.id)
      this.#report(`acde-host: [${name}] stopped (${why})`)
      return
    }
    if (crashes.tooMany) {
      this.#running.delete(app.id)
      this.#failed.add(app.id)
      this.#report(`acde-host: [${name}] stopped ${crashes.count} times in a minute (${why}); not started again while the app's windows are open`)
      return
    }
    this.#report(`acde-host: [${name}] stopped (${why}); starting it again`)
    unref(setTimeout(() => {
      if (this.#running.get(app.id) !== running || running.stopping || running.pid !== null) return
      if (!this.#spawn(running)) this.#running.delete(app.id)
    }, 500))
  }

  async stop(id: string): Promise<void> {
    this.#failed.delete(id)
    this.#crashes.forget(id)
    const running = this.#running.get(id)
    if (!running) return
    this.#running.delete(id)
    running.stopping = true
    const pid = running.pid
    if (pid === null) return
    const timer = unref(stopGroup(pid, () => running.pid === pid, AppBackends.STOP_MS))
    await running.ended
    clearTimeout(timer)
    for (const name of AppBackends.#list(running.sockets)) if (name.endsWith('.sock')) rmSync(join(running.sockets, name), { force: true })
    this.#report(`acde-host: [${id}#backend] stopped`)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)))
  }

  static #list(dir: string): string[] {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
}
