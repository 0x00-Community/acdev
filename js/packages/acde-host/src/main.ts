import { installCore } from '@dopame/acde-dom/core'
import { Appearance } from './appearance'
import { Autostart } from './autostart'
import { Broker } from './broker'
import { DebugDir } from './debug'
import type { GreetUser, Native, NativeDesktopBus } from './native'
import { WaylandSessions } from './foreign'
import { DesktopEntries } from './open'
import { Packages, type InstalledDesktop } from './packages'
import { AppRegistry } from './apps'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from './sys/fs'
import { bindNatives, type Natives } from './sys/natives'
import { xdgHome } from './sys/os'
import { dirname, join, resolve } from './sys/path'
import { onceSignal, process } from './sys/process'
import { unref, within } from './sys/timers'
import { StartupTimeline } from './timeline'
import { Level, Log } from './log'

class Args {
  readonly values: Record<string, string | boolean | string[]> = {}
  readonly positionals: string[] = []

  constructor(argv: readonly string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; default?: string | boolean | string[] }>) {
    for (const [name, option] of Object.entries(options)) if (option.default !== undefined) this.values[name] = option.default
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!
      if (arg === '--') continue
      if (!arg.startsWith('--')) {
        this.positionals.push(arg)
        continue
      }
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
      const option = options[name]
      if (!option) throw new Error(`acde: unknown option --${name}`)
      if (option.type === 'boolean') {
        this.values[name] = inline === undefined ? true : inline !== 'false'
        continue
      }
      const value = inline ?? argv[++i]
      if (value === undefined) throw new Error(`acde: --${name} needs a value`)
      if (option.multiple) this.values[name] = [...((this.values[name] as string[] | undefined) ?? []), value]
      else this.values[name] = value
    }
  }

  string(name: string): string | undefined {
    const value = this.values[name]
    return typeof value === 'string' ? value : undefined
  }

  flag(name: string): boolean {
    return this.values[name] === true
  }

  list(name: string): string[] {
    const value = this.values[name]
    return Array.isArray(value) ? value : []
  }
}

class Main {
  static readonly AUTOSTART_AFTER_SHOWN = 300
  static readonly AUTOSTART_WAIT = 5000
  static readonly CLOSE_WAIT = 3000

  static session(): boolean {
    const { env } = process
    if (env['ACDE_BACKEND'] === 'drm') return true
    if (env['ACDE_BACKEND'] === 'rdp') return false
    return !env['DISPLAY'] && !env['WAYLAND_DISPLAY']
  }

  static readonly LOGIN_COMMAND = ['/usr/bin/acde']

  static greeter(native: Native, broker: Broker, packages: Packages): Record<string, unknown> {
    const greetd = native.Greetd
    if (!greetd) throw new Error('acde --greeter: this acde has no greetd support (runtime Greetd)')
    const command = (id: string | null): [string[], string[]] => {
      if (!id) return [Main.LOGIN_COMMAND, ['XDG_SESSION_TYPE=wayland']]
      const target = packages.find(id)
      if (!target || target.id === broker.desktopId) throw Object.assign(new Error(`no desktop ${id}`), { status: 404 })
      if (target.kind === 'session') return [[...target.argv], WaylandSessions.environment(target).map(([name, value]) => `${name}=${value}`)]
      return [[...Main.LOGIN_COMMAND, '--desktop', target.id], ['XDG_SESSION_TYPE=wayland']]
    }
    const file = join(xdgHome('state'), 'acde', 'greeter.json')
    const chosen = (): Record<string, string> => {
      try {
        const read = JSON.parse(readFileSync(file, 'utf8')) as unknown
        return typeof read === 'object' && read !== null ? (read as Record<string, string>) : {}
      } catch {
        return {}
      }
    }
    return {
      users: (): (GreetUser & { desktop: string | null })[] => {
        const last = chosen()
        return greetd.users().map((user) => ({ ...user, desktop: typeof last[user.name] === 'string' ? last[user.name]! : null }))
      },
      login: async (user: string, password: string, desktop?: string | null): Promise<void> => {
        if (!greetd.available()) throw new Error('not started by greetd (GREETD_SOCK is not set): nobody to log in with')
        const id = desktop ? String(desktop) : null
        const [cmd, env] = command(id)
        await greetd.login(String(user), String(password), cmd, env)
        if (id) {
          try {
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, JSON.stringify({ ...chosen(), [String(user)]: id }))
          } catch (error) {
            Log.write(Level.Warn, 'acde_host', `${file} not written: ${(error as Error).message}`)
          }
        }
        broker.session.end('logout')
      },
    }
  }

  static #switch(name: string): boolean | null {
    const set = process.env[name]
    return set === '1' ? true : set === '0' ? false : null
  }

  static storageFile(desktop: string): string | null {
    const set = process.env['ACDE_STORAGE']
    if (set !== undefined) return set || null
    const dir = join(xdgHome('config'), 'acde', 'storage')
    const file = join(dir, `${desktop}.json`)
    for (const [before, now] of Object.entries(Packages.RENAMED)) {
      const old = join(dir, `${before}.json`)
      if (now !== desktop || existsSync(file) || !existsSync(old)) continue
      try {
        renameSync(old, file)
        Log.write(Level.Info, 'acde_host', `desktop ${before} is now ${now}: its page storage moved to ${file}`)
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `desktop ${before} is now ${now}: ${old} not moved: ${(error as Error).message}`)
      }
    }
    return file
  }

  static remember(id: string): void {
    const file = Packages.rememberFile()
    try {
      if (existsSync(file) && readFileSync(file, 'utf8').trim() === id) return
      Packages.remember(id)
    } catch (error) {
      Log.write(Level.Warn, 'acde_host', `${file} not written: ${(error as Error).message}`)
    }
  }

  static async open(native: Native, argv: string[]): Promise<number> {
    const args = new Args(argv, { app: { type: 'string' } })
    if (!args.positionals.length) {
      process.stderr.write('acde open [--app <id>] <path|uri>...: what to open\n')
      return 2
    }
    if (!native.DesktopBus) {
      process.stderr.write('acde open: this acde has no session bus support (runtime DesktopBus)\n')
      return 1
    }
    const uris = args.positionals.map((p) => (/^[a-z][\w+.-]*:/i.test(p) ? p : resolve(p)))
    try {
      await native.DesktopBus.send(uris, args.string('app') ?? null)
      return 0
    } catch (error) {
      const message = (error as Error).message
      let body: { code?: string; message?: string } = {}
      try {
        body = JSON.parse(message) as typeof body
      } catch {
      }
      process.stderr.write(`acde open: ${body.message ?? message}\n`)
      return body.code === 'no_session' ? 3 : 1
    }
  }

  static command(name: string, argv: string[]): number {
    const args = new Args(argv, { package: { type: 'string' }, desktop: { type: 'string' }, exec: { type: 'string' } })
    const pkg = args.string('package')
    const packages = new Packages(pkg ? [resolve(pkg)] : [])
    if (name === 'desktops') {
      let chosen: string | null = null
      try {
        chosen = packages.choose(args.string('desktop') ?? null, true, true).id
      } catch {
      }
      for (const d of packages.desktops()) process.stdout.write(`${d.id === chosen ? '*' : ' '} ${d.id}\t${d.name}\t${d.package.name} (${d.package.dir})\n`)
      for (const s of packages.sessions()) process.stdout.write(`${s.id === chosen ? '*' : ' '} ${s.id}\t${s.name}\twayland session (${s.file})\n`)
      return 0
    }
    const out = args.positionals[0]
    if (!out) {
      process.stderr.write(`acde ${name} <dir> [--package <dir>]: where to write the ${name === 'sessions' ? 'session entries' : 'desktop entries'}\n`)
      return 2
    }
    const only = pkg ? resolve(pkg) : null
    if (name === 'applications') {
      const apps = new AppRegistry({ packages: packages.packages.filter((p) => !only || p.dir === only) }).list()
      mkdirSync(out, { recursive: true })
      const files = [...DesktopEntries.entries(apps, args.string('exec') ?? 'acde'), { name: 'acde-mimeapps.list', text: DesktopEntries.mimeapps(apps) }]
      for (const file of files) {
        writeFileSync(join(out, file.name), file.text)
        process.stdout.write(`${join(out, file.name)}\n`)
      }
      return 0
    }
    const desktops = packages.desktops().filter((d) => !only || d.package.dir === only)
    mkdirSync(out, { recursive: true })
    for (const desktop of desktops) {
      const file = Packages.sessionFile(desktop)
      writeFileSync(join(out, file.name), file.text)
      process.stdout.write(`${join(out, file.name)}\n`)
    }
    return 0
  }

  static async run(native: Native): Promise<number> {
    const argv = process.argv.filter((arg) => arg !== '--')
    if (argv[0] === 'desktops' || argv[0] === 'sessions' || argv[0] === 'applications') return Main.command(argv[0], argv.slice(1))
    if (argv[0] === 'open') return Main.open(native, argv.slice(1))
    const args = new Args(argv, {
      desktop: { type: 'string' },
      size: { type: 'string', default: '1440x900' },
      scale: { type: 'string', default: '1' },
      stats: { type: 'boolean', default: false },
      launch: { type: 'string', multiple: true, default: [] },
      seconds: { type: 'string', default: '0' },
      greeter: { type: 'boolean', default: false },
    })
    const wanted = args.flag('greeter') ? join(Packages.HOST, 'greet') : args.string('desktop') ?? null
    const packages = new Packages(wanted && !/^[\w-]+$/.test(wanted) && !wanted.startsWith(WaylandSessions.PREFIX) ? [resolve(wanted)] : [])
    if (args.positionals.length && args.positionals[0] !== 'window') throw new Error(`acde: unknown command ${args.positionals[0]} (acde window <app>)`)
    if (args.positionals[0] === 'window' && !args.positionals[1]) throw new Error('acde window <app>: which app (the id in its manifest, e.g. files, term, editor)')
    const standalone = args.positionals[1] ?? null
    const desktop = standalone && !wanted && !packages.desktops().length ? packages.bare() : packages.choose(wanted, !standalone)
    if (desktop.kind === 'session') {
      const file = WaylandSessions.handOff(desktop)
      Log.write(Level.Info, 'acde_host', `${desktop.id} chosen: handing the session over (${desktop.argv.join(' ')}), ${file}, exit ${WaylandSessions.HANDOFF_EXIT}`)
      return WaylandSessions.HANDOFF_EXIT
    }
    if (Main.session() && !args.flag('greeter') && !standalone) Main.remember(desktop.id)
    const [width, height] = (args.string('size') ?? '1440x900').split('x').map(Number) as [number, number]
    const scale = Number(args.string('scale') ?? '1')
    return Main.broker(native, args, packages, desktop, width, height, scale, standalone)
  }

  static async broker(native: Native, args: Args, packages: Packages, desktop: InstalledDesktop, width: number, height: number, scale: number, standalone: string | null): Promise<number> {
    const session = Main.session(), greeter = args.flag('greeter')
    const fixed = Appearance.fixed()
    const broker = new Broker(native, {
      packages,
      desktop,
      width,
      height,
      scale,
      reducedMotion: Main.#switch('ACDE_REDUCED_MOTION'),
      dark: fixed ?? false,
      session,
      storageFile: (id) => (greeter ? null : Main.storageFile(id)),
      standalone,
    })
    const started = performance.now()
    const scheme = fixed === null ? Appearance.follow(native, (dark) => broker.setDark(dark)) : null
    await broker.startServices()
    if (greeter) broker.addService('greeter', Main.greeter(native, broker, packages))
    if (scheme) await within(scheme, Math.max(0, Appearance.WAIT_MS - (performance.now() - started)), undefined)
    broker.startDesktop()
    Log.write(Level.Info, 'acde_host', `broker started, the desktop is loading (${(performance.now() - started).toFixed(0)}ms)`)
    const shell = broker.shell
    if (session && !greeter && !standalone) broker.desk.startPower()
    if (session && !greeter) {
      try {
        shell.launch(['fcitx5', '-d', '--replace'])
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `fcitx5 not started: ${(error as Error).message}`)
      }
      if (!standalone) broker.desk.restoreBluetooth()
    }
    for (const command of args.list('launch')) shell.launch(command.split(' ').filter(Boolean))
    if (Autostart.wanted(session) && !standalone && !greeter) {
      let started = false
      const start = () => {
        if (started) return
        started = true
        StartupTimeline.mark('autostart')
        Autostart.start(shell.launch.bind(shell), new Set(session ? ['fcitx5'] : []))
      }
      broker.onDesktopShown = () => unref(setTimeout(start, Main.AUTOSTART_AFTER_SHOWN))
      unref(setTimeout(start, Main.AUTOSTART_WAIT))
    }
    let bus: NativeDesktopBus | null = null
    if ((Main.#switch('ACDE_BUS_NAMES') ?? session) && !greeter && native.DesktopBus) {
      try {
        bus = native.DesktopBus.open((request) => broker.openFromBus(request))
        Log.write(Level.Info, 'acde_host', `on the session bus as ${bus.names.join(', ') || 'nothing (the names are taken)'}`)
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `no session bus names: ${(error as Error).message}`)
      }
    }
    const stop = new AbortController()
    onceSignal('SIGINT', () => stop.abort())
    onceSignal('SIGTERM', () => stop.abort())
    const seconds = Number(args.string('seconds') ?? '0')
    if (seconds > 0) unref(setTimeout(() => stop.abort(), seconds * 1000))
    const debug = process.env['ACDE_DEBUG_DIR']
    if (debug) DebugDir.watch(debug, broker)
    const ended = await broker.run(stop.signal)
    if (args.flag('stats')) process.stderr.write(`compositor ${JSON.stringify(shell.stats())}\nwindows at exit: ${JSON.stringify(broker.windows)}\n`)
    const code = broker.session.exitCode(ended)
    Log.write(Level.Info, 'acde_host', `${broker.session.ending ? `session ${broker.session.ending}` : `ended (${ended})`}, exit ${code}`)
    bus?.close()
    if (session) broker.session.terminate()
    await within(broker.close(), Main.CLOSE_WAIT, undefined)
    shell.quit()
    return code
  }
}

export default async function main(natives: Natives): Promise<void> {
  installCore(globalThis, natives.host, { nodeTimers: true })
  bindNatives(natives)
  let code = 1
  try {
    code = await Main.run(natives.native as unknown as Native)
  } catch (error) {
    process.stderr.write(`acde: ${(error as Error).stack ?? error}\n`)
  }
  process.exit(code)
}
