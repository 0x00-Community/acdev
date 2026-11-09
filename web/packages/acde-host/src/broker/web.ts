import type { WebGrants, WebThreadHandle } from '../sys/natives'
import { process } from '../sys/process'
import type { AppManifest, Capabilities } from '../apps'
import type { OpenCaller } from '../open'
import { Rpc } from '../rpc'

export class Web {
  readonly rpc: Rpc
  hung = false
  closing = false
  reloading = false
  readonly owns = new Map<number, number>()
  readonly thread: WebThreadHandle
  onPost: ((message: unknown) => void) | null = null
  readonly #exited: Promise<number>

  constructor(
    readonly kind: 'desktop' | 'window',
    readonly name: string,
    readonly window: number,
    readonly app: AppManifest | null,
    spawn: (onMessage: (message: unknown) => void, onExit: (code: number) => void) => WebThreadHandle,
  ) {
    let exit!: (code: number) => void
    this.#exited = new Promise((resolve) => (exit = resolve))
    this.rpc = new Rpc((message) => this.thread.post(message))
    this.thread = spawn((message) => {
      if (!this.rpc.receive(message)) this.onPost?.(message)
    }, exit)
  }

  terminate(): Promise<number> {
    this.thread.terminate()
    return this.#exited
  }

  static caller(app: AppManifest): OpenCaller {
    const fs = Web.grants(app.id, app.capabilities).fs
    return { roots: fs === true ? null : (fs ?? []), owner: app.id }
  }

  static grants(app: string | null, caps: Capabilities | null): Omit<WebGrants, 'storage'> {
    if (!caps) return { app, fs: true, terminal: true, network: true, office: true, camera: true, microphone: true }
    const fs = caps.fs
    return {
      app,
      fs: typeof fs === 'object' && fs ? [...fs.roots] : fs ? true : null,
      terminal: !!caps.terminal,
      network: !!caps.network,
      office: !!caps.office,
      camera: caps.camera === true,
      microphone: caps.microphone === true,
    }
  }

  static env(): Record<string, string> {
    const keep = /^(ACDE_|XDG_|LANG$|LC_|LANGUAGE$|HOME$|USER$|DBUS_SESSION_BUS_ADDRESS$|RUST_LOG$|TZ$|PATH$|RUST_BACKTRACE$)/
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => keep.test(entry[0]) && entry[1] !== undefined))
  }

  static refused(web: Web, what: string): Error {
    const error = new Error(`${web.app?.label ?? web.kind} may not use ${what} (not in its manifest's capabilities)`)
    return Object.assign(error, { status: 403, code: 'forbidden' })
  }
}
