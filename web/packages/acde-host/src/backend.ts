import type { AppManifest } from './apps'
import { Crashes } from './crashes'
import { PageSource } from './page'
import { mkdirSync, readDirOr, rmSync, stat } from './sys/fs'
import { sys } from './sys/natives'
import { runtimeDir, xdgHome } from './sys/os'
import { dirname, join } from './sys/path'
import { process, stopGroup } from './sys/process'
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

type Mode = 'channel' | 'sockets'

interface AppBackendsOptions {
  readonly resources: () => { prefix: string; dirs: string[] }[]
  readonly wanted: (id: string) => boolean
}

export class AppBackends {
  static readonly RESTARTS = 3
  static readonly STOP_MS = 3000
  static readonly ENV = ['HOME', 'USER', 'PATH', 'LANG', 'LANGUAGE', 'TZ', 'XDG_RUNTIME_DIR']

  readonly #options: AppBackendsOptions
  readonly #running = new Map<string, Running>()
  readonly #crashes = new Crashes(AppBackends.RESTARTS)
  readonly #failed = new Set<string>()

  constructor(options: AppBackendsOptions) {
    this.#options = options
  }

  static get windows(): boolean {
    return sys().spawnBackend !== undefined
  }

  static socketDir(id: string): string {
    return join(runtimeDir(), 'acde', 'apps', id)
  }

  static env(key: string): string | undefined {
    const env = process.env
    if (env[key] !== undefined || process.platform !== 'win32') return env[key]
    const name = Object.keys(env).find((candidate) => candidate.toUpperCase() === key.toUpperCase())
    return name === undefined ? undefined : env[name]
  }

  static mode(argv: readonly string[]): Mode {
    return /(^|[\\/])node(\.exe)?$/i.test(argv[0] ?? '') ? 'channel' : 'sockets'
  }

  static webInit(id: string): { channel: true } | { sockets: string } {
    if (!AppBackends.windows) return { sockets: AppBackends.socketDir(id) }
    const argv = AppBackends.argv(AppBackends.env('PATH'), 'acde-listen.js', 'server.js', process.env['ACDE_RUNTIME'])
    if (argv && AppBackends.mode(argv) === 'channel') return { channel: true }
    return { sockets: join(AppBackends.env('XDG_RUNTIME_DIR') || AppBackends.env('TMP') || AppBackends.env('TEMP') || '', 'acde', 'b') }
  }

  static #dataDir(id: string): string {
    return join(xdgHome('data'), 'acde', 'apps', id)
  }

  static #report(name: string, line: string, level = Level.Info): void {
    Log.write(level, 'acde_host', `[${name}] ${line}`)
  }

  start(app: AppManifest): void {
    if (!app.backend || this.#running.has(app.id) || this.#failed.has(app.id)) return
    const windows = AppBackends.windows
    const sockets = windows ? '' : AppBackends.socketDir(app.id)
    try {
      if (!windows) mkdirSync(sockets, { recursive: true, mode: 0o700 })
      mkdirSync(AppBackends.#dataDir(app.id), { recursive: true })
    } catch (error) {
      AppBackends.#report(`${app.id}#backend`, (error as Error).message, Level.Warn)
      return
    }
    if (!windows) AppBackends.#removeSockets(sockets)
    const running: Running = { app, sockets, pid: null, stopping: false, ended: Promise.resolve(), end: () => undefined }
    this.#running.set(app.id, running)
    if (!this.#spawn(running)) this.#running.delete(app.id)
  }

  static argv(path: string | undefined, preload: string, server: string, prefer?: string): string[] | null {
    const windows = process.platform === 'win32'
    const find = (name: string) => {
      for (const dir of (path ?? '').split(windows ? ';' : ':')) {
        const exe = dir && join(dir, windows ? `${name}.exe` : name)
        if (exe && stat(exe)?.isFile) return exe
      }
      return null
    }
    const href = windows ? `file:///${encodeURI(preload.replaceAll('\\', '/'))}` : new URL(`file://${preload}`).href
    const order = prefer === 'node' ? ['node', 'bun'] : ['bun', 'node']
    for (const name of order) {
      const exe = find(name)
      if (exe) return name === 'bun' ? [exe, '--preload', preload, server] : [exe, '--import', href, server]
    }
    return null
  }

  #spawn(running: Running): boolean {
    const { app } = running
    const name = `${app.id}#backend`
    const server = PageSource.file(app.backend!.entry, this.#options.resources())
    const preload = server && join(dirname(server), 'acde-listen.js')
    if (!server || !stat(preload!)?.isFile) {
      AppBackends.#report(name, `not started: ${server ? `no acde-listen.js beside ${server} (built by an older acde: acde build it again)` : `no file for ${app.backend!.entry}`}`, Level.Warn)
      return false
    }
    const { spawn, spawnBackend, proxyEnv } = sys()
    if (!spawn && !spawnBackend) {
      AppBackends.#report(name, 'not started: this acde cannot start processes', Level.Warn)
      return false
    }
    const argv = AppBackends.argv(AppBackends.env('PATH'), preload!, server, process.env['ACDE_RUNTIME'])
    if (!argv) {
      AppBackends.#report(name, 'not started: neither bun nor node is on PATH', Level.Warn)
      return false
    }
    const data = AppBackends.#dataDir(app.id)
    const env: Record<string, string> = {}
    for (const key of AppBackends.ENV) {
      const value = AppBackends.env(key)
      if (value) env[key] = value
    }
    Object.assign(env, proxyEnv(), { ACDE_APP_ID: app.id, ACDE_APP_DATA: data, PORT: String(app.backend!.port), NODE_ENV: 'production' })
    if (!spawnBackend) env['ACDE_APP_SOCKETS'] = running.sockets
    running.ended = new Promise((done) => (running.end = done))
    const onExit = (code: number | null, signal: number | null) => this.#exited(running, code, signal)
    const prefix = `[${name}] `
    try {
      running.pid = spawnBackend
        ? spawnBackend(argv, { cwd: data, env, prefix, app: app.id, mode: AppBackends.mode(argv), preload: preload! }, onExit)
        : spawn!(argv, { cwd: data, env, prefix }, onExit)
    } catch (error) {
      running.end()
      AppBackends.#report(name, `not started: ${(error as Error).message}`, Level.Warn)
      return false
    }
    AppBackends.#report(name, `started (pid ${running.pid}, port ${app.backend!.port})`)
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
      AppBackends.#report(name, `stopped (${why})`)
      return
    }
    if (crashes.tooMany) {
      this.#running.delete(app.id)
      this.#failed.add(app.id)
      AppBackends.#report(name, `stopped ${crashes.count} times in a minute (${why}); not started again while the app's windows are open`, Level.Warn)
      return
    }
    AppBackends.#report(name, `stopped (${why}); starting it again`, Level.Warn)
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
    const stopBackend = sys().stopBackend
    if (stopBackend) {
      stopBackend(pid, AppBackends.STOP_MS)
      await running.ended
    } else {
      const timer = unref(stopGroup(pid, () => running.pid === pid, AppBackends.STOP_MS))
      await running.ended
      clearTimeout(timer)
      AppBackends.#removeSockets(running.sockets)
    }
    AppBackends.#report(`${id}#backend`, 'stopped')
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)))
  }

  static #removeSockets(dir: string): void {
    for (const name of readDirOr(dir)) if (name.endsWith('.sock')) rmSync(join(dir, name), { force: true })
  }
}
