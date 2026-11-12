import type { WebGrants, WebThreadHandle } from '../sys/natives'
import { process } from '../sys/process'
import type { AppManifest, Capabilities } from '../apps'
import type { OpenCaller } from '../open'
import { Rpc } from '../rpc'
import type { WebTier } from './access/tier'
import { FileAccess } from './access/files'
import { Level, Log } from '../log'

export class Web {
  readonly rpc: Rpc
  hung = false
  closing = false
  reloading = false
  onReload: (() => void) | null = null
  readonly owns = new Map<number, number>()
  readonly startedPids = new Set<number>()
  readonly started = new Set<number>()
  readonly thread: WebThreadHandle
  onPost: ((message: unknown) => void) | null = null
  readonly #exited: Promise<number>

  constructor(
    readonly kind: 'desktop' | 'window',
    readonly name: string,
    readonly window: number,
    readonly app: AppManifest | null,
    spawn: (onMessage: (message: unknown) => void, onExit: (code: number) => void) => WebThreadHandle,
    readonly tier: WebTier,
    readonly url: string | null = null,
  ) {
    let exit!: (code: number) => void
    this.#exited = new Promise((resolve) => (exit = resolve))
    this.rpc = new Rpc((message) => this.thread.post(message))
    this.thread = spawn((message) => {
      if (!this.rpc.receive(message)) this.onPost?.(message)
    }, exit)
  }

  terminate(): Promise<number> {
    if (this.reloading) this.onReload?.()
    this.thread.terminate()
    return this.#exited
  }

  static caller(app: AppManifest, tier: WebTier, permitted: (capability: string) => boolean = () => true): OpenCaller {
    const fs = FileAccess.grant(app.capabilities, tier)
    if (fs === true) return { roots: null, owner: app.id }
    const places = fs ? fs.places.filter((place) => permitted(`fs.${place}`)) : []
    return { roots: [], owner: app.id, places, paths: !!fs?.paths }
  }

  static grants(app: string | null, caps: Capabilities | null, tier: WebTier | null = null): Omit<WebGrants, 'storage'> {
    if (!caps) return { app, fs: true, terminal: true, network: true, office: true, camera: true, microphone: true }
    return {
      app,
      fs: FileAccess.grant(caps, tier),
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

  shell(module: string): boolean {
    return this.kind === 'desktop' || (this.tier.shell as readonly string[]).includes(module)
  }

  static refused(web: { readonly app: AppManifest | null; readonly kind: string }, what: string): Error {
    const error = new Error(`${web.app?.label ?? web.kind} may not use ${what} (not in its manifest's capabilities)`)
    return Object.assign(error, { status: 403, code: 'forbidden' })
  }
}
