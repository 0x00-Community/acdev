import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Browser, Lookup } from './devtools.ts'
import { slug } from './paths.ts'

export interface ActivePort {
  readonly port: number
  readonly path: string
}

export class DevtoolsBrowser {
  static readonly FILE = 'DevToolsActivePort'
  static readonly START_MS = 20_000
  static readonly POLL_MS = 100
  static readonly CALL_MS = 10_000
  static readonly ALIVE_MS = 2_000

  static cacheDir({ platform, env, home }: Lookup): string {
    if (platform === 'win32') return env['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
    if (platform === 'darwin') return join(home, 'Library', 'Caches')
    const set = env['XDG_CACHE_HOME']
    return set && isAbsolute(set) ? set : join(home, '.cache')
  }

  static profile(lookup: Lookup, browser: Browser): string {
    return join(DevtoolsBrowser.cacheDir(lookup), 'acde', 'devtools', slug(browser.name).toLowerCase())
  }

  static args(profile: string): string[] {
    return [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check']
  }

  static activePort(profile: string): ActivePort | null {
    let text: string
    try {
      text = readFileSync(join(profile, DevtoolsBrowser.FILE), 'utf8')
    } catch {
      return null
    }
    const [first = '', path = ''] = text.split(/\r?\n/).map((line) => line.trim())
    const port = Number(first)
    return Number.isInteger(port) && port > 0 && path.startsWith('/') ? { port, path } : null
  }

  static async alive(active: ActivePort): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${active.port}/json/version`, {
        signal: AbortSignal.timeout(DevtoolsBrowser.ALIVE_MS),
      })
      await response.body?.cancel()
      return response.ok
    } catch {
      return false
    }
  }

  static async open(browser: Browser, url: string, lookup: Lookup): Promise<'reused' | 'started'> {
    const profile = DevtoolsBrowser.profile(lookup, browser)
    const running = DevtoolsBrowser.activePort(profile)
    if (running && (await DevtoolsBrowser.alive(running))) {
      await DevtoolsBrowser.createTarget(running, url)
      return 'reused'
    }
    mkdirSync(profile, { recursive: true })
    rmSync(join(profile, DevtoolsBrowser.FILE), { force: true })
    const active = await DevtoolsBrowser.start(browser, profile)
    await DevtoolsBrowser.createTarget(active, url)
    return 'started'
  }

  static async start(browser: Browser, profile: string): Promise<ActivePort> {
    const args = DevtoolsBrowser.args(profile)
    const script = process.platform === 'win32' && /\.(cmd|bat)$/i.test(browser.path)
    const quote = (arg: string) => `"${arg.replace(/"/g, '""')}"`
    const child = script
      ? spawn([browser.path, ...args].map(quote).join(' '), { shell: true, detached: true, stdio: 'ignore' })
      : spawn(browser.path, args, { detached: true, stdio: 'ignore' })
    let failed: string | null = null
    child.once('error', (error) => {
      failed = error.message
    })
    child.once('exit', (code) => {
      if (code !== 0) failed ??= `it exited with ${code}`
    })
    child.unref()
    for (const until = Date.now() + DevtoolsBrowser.START_MS; Date.now() < until;) {
      const active = DevtoolsBrowser.activePort(profile)
      if (active) return active
      if (failed) throw new Error(`${browser.name} did not start: ${failed}`)
      await sleep(DevtoolsBrowser.POLL_MS)
    }
    const waited = DevtoolsBrowser.START_MS / 1000
    throw new Error(`${browser.name} wrote no ${DevtoolsBrowser.FILE} in ${profile} within ${waited} s`)
  }

  static createTarget(active: ActivePort, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${active.port}${active.path}`)
      const done = (error?: Error) => {
        clearTimeout(timer)
        socket.close()
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => done(new Error('the browser did not answer Target.createTarget')),
        DevtoolsBrowser.CALL_MS)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, newWindow: true } }))
      })
      socket.addEventListener('message', (event) => {
        let message: { id?: unknown; error?: { message?: unknown } }
        try {
          message = JSON.parse(String(event.data)) as typeof message
        } catch {
          done(new Error('the browser answered Target.createTarget with something that is not JSON'))
          return
        }
        if (message?.id !== 1) return
        const said = message.error?.message
        const why = typeof said === 'string' ? said : 'failed'
        done(message.error ? new Error(`Target.createTarget: ${why}`) : undefined)
      })
      socket.addEventListener('error', () => done(new Error(`could not connect to the browser on port ${active.port}`)))
    })
  }
}
