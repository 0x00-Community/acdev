import { rmSync, watch } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AppPackage, Built } from './package.ts'

const IGNORED = new Set(['.acde', 'node_modules', '.git', 'dist', 'build', 'out', '.next', '.output', '.nuxt', '.svelte-kit', '.astro', '.turbo', '.cache'])
const SETTLE_MS = 150

export interface Target {
  readonly kind: 'app' | 'desktop'
  readonly id: string
}

export class DevSession {
  #socket: net.Socket | null = null
  #building = false
  #again = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly pkg: AppPackage,
    readonly out: string,
    readonly acdert: string,
  ) {}

  static endpoint(): string {
    return process.platform === 'win32' ? `\\\\.\\pipe\\acde-dev-${process.pid}` : join(tmpdir(), `acde-dev-${process.pid}.sock`)
  }

  static target(built: Built, app: string | undefined): Target {
    if (app !== undefined) {
      if (!built.apps.includes(app)) throw new Error(`no app ${JSON.stringify(app)} here (${built.apps.join(', ')})`)
      return { kind: 'app', id: app }
    }
    const desktop = built.desktops[0]
    if (desktop !== undefined) return { kind: 'desktop', id: desktop }
    const first = built.apps[0]
    if (first === undefined) throw new Error('nothing to run: no desktop and no app')
    return { kind: 'app', id: first }
  }

  async run(app: string | undefined): Promise<number> {
    const built = await this.pkg.build(this.out)
    const target = DevSession.target(built, app)
    const endpoint = DevSession.endpoint()
    if (process.platform !== 'win32') rmSync(endpoint, { force: true })
    const server = net.createServer((socket) => this.#accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, () => resolve())
    })
    const paths = [built.dir, process.env['ACDE_PATH']].filter(Boolean).join(delimiter)
    console.log(`acde: dev ${target.kind} ${target.id} (${built.dir}); 改了文件就重新构建、重新加载`)
    const child = Bun.spawn([this.acdert, target.kind, target.id], { env: { ...process.env, ACDE_DEV: endpoint, ACDE_PATH: paths }, stdio: ['inherit', 'inherit', 'inherit'] })
    const watcher = watch(this.pkg.dir, { recursive: true }, (_, file) => this.#changed(file === null ? null : String(file)))
    const code = await child.exited
    watcher.close()
    server.close()
    if (process.platform !== 'win32') rmSync(endpoint, { force: true })
    return code
  }

  #accept(socket: net.Socket): void {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = null
    })
  }

  #changed(file: string | null): void {
    if (file === null) return
    const top = file.split(/[\\/]/)[0] ?? ''
    if (IGNORED.has(top)) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#rebuild(), SETTLE_MS)
  }

  async #rebuild(): Promise<void> {
    if (this.#building) {
      this.#again = true
      return
    }
    this.#building = true
    const started = performance.now()
    try {
      const built = await this.pkg.build(this.out)
      console.log(`acde: 重新构建好了 (${Math.round(performance.now() - started)} ms), 重新加载`)
      for (const app of built.apps) this.send({ type: 'reload', app })
      if (built.desktops.length) this.send({ type: 'reload' })
    } catch (error) {
      console.error(`acde: 构建失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.#building = false
      if (this.#again) {
        this.#again = false
        void this.#rebuild()
      }
    }
  }

  send(message: Record<string, unknown>): void {
    this.#socket?.write(`${JSON.stringify(message)}\n`)
  }
}
