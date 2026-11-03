import { install, installBackendTransport, type AudioNative, type BackendTransport, type DomNative, type GpuNative, type HostNative } from '@dopame/acde-dom'
import type { WebInit } from './broker'
import { WindowFrame } from './frame'
import { Host } from './host'
import type { ImeEvent, NativeIme } from './ime'
import type { NativeSurface } from './native'
import { PageSource } from './page'
import { PageCalls } from './pagecalls'
import { PageInspect } from './pageinspect'
import { Pinned } from './pinned'
import { RemoteBridge, WindowList, WindowSelf } from './remote'
import { Rpc, type RpcPort } from './rpc'
import { StorageFile } from './storage'
import { OfficePage } from './office'
import { readFileSync } from './sys/fs'
import { bindNatives, type Natives } from './sys/natives'
import { process } from './sys/process'
import { StartupTimeline } from './timeline'
import { WebAppPage } from './webapp'

interface WebNatives extends Natives {
  readonly host: HostNative & { onTaskEnd(fn: () => void): void; setReporter(fn: (error: unknown, promise?: Promise<unknown>) => void): void; requestFrame(): void }
  readonly port: { post(message: unknown): void; onMessage(fn: (message: unknown) => void): void }
  readonly init: WebInit
  readonly env: Record<string, string>
  createDocument(width: number, height: number, scale: number, options: { resources: { prefix: string; dirs: string[] }[]; reducedMotion: boolean; dark: boolean }): DomNative
  claimSurface(token: bigint): NativeSurface
  readonly Ime?: new (callback: (event: ImeEvent) => void) => NativeIme
  readonly gpu?: GpuNative
  readonly audio?: AudioNative
  readonly backend?: Omit<BackendTransport, 'port'>
  readonly fs?: object
  readonly terminal?: object
  readonly network?: object
  readonly office?: object
}

export default async function boot(natives: WebNatives): Promise<void> {
  bindNatives(natives)
  const { host, port, init } = natives
  Host.label = init.name
  const listeners: ((message: unknown) => void)[] = []
  port.onMessage((message) => {
    for (const listener of listeners) listener(message)
  })
  const brokerPort: RpcPort = { postMessage: (message) => port.post(message), on: (_event, listener) => listeners.push(listener) }

  const dom = natives.createDocument(init.width, init.height, init.scale, { resources: init.resources, reducedMotion: init.reducedMotion === true, dark: init.dark === true })
  const surface = natives.claimSurface(init.token)
  host.requestFrame = () => surface.requestFrame()

  const storage = init.storageFile ? new StorageFile(init.storageFile) : null
  const htmlEntry = init.kind === 'window' && !!init.app && PageSource.isHtml(init.app.entry)
  const htmlPage = htmlEntry ? PageSource.htmlFor(init.app!.entry, init.url, init.resources) : null
  if (htmlEntry) {
    const read = host.readAsset.bind(host)
    const entry = `${PageSource.ORIGIN}${init.app!.entry}`
    host.readAsset = (url) => read(url) ?? (/^http:\/\/acde\.local\/(?:[?#].*)?$/.test(url) ? read(entry) : null)
  }
  const page = install(globalThis, dom, host, {
    url: (htmlEntry ? init.url : undefined) ?? `${PageSource.ORIGIN}/`,
    ...init.languages,
    reducedMotion: init.reducedMotion === true,
    localStorage: storage?.read() ?? null,
    onStorageChange: storage ? (entries) => storage.changed(entries) : undefined,
    gpu: natives.gpu,
    audio: natives.audio,
    ...(init.screen && { screen: init.screen }),
  })
  host.onTaskEnd(() => page.endTask())
  host.setReporter((error, promise) => {
    if (promise) page.unhandledRejection(promise, error)
    else page.reportError(error)
  })

  const rpc = new Rpc(brokerPort)
  const self = init.kind === 'window' && init.app ? new WindowSelf(rpc, surface, globalThis as never, init.request ?? null) : null
  const windows = new WindowList(rpc)
  const bridge = new RemoteBridge(rpc, init, self, windows)
  if (init.kind === 'window' && init.app?.backend && natives.backend) installBackendTransport({ ...natives.backend, port: init.app.backend.port })
  const web = new Host(page, dom, init.scale, natives.Ime, windows)
  const debug = !!natives.env['ACDE_DEBUG_DIR']
  const inspect = new PageInspect(page, dom, web)
  rpc.serve(async (service, method, args) => {
    if (service === 'window' && self) return self.serve(method, args)
    if (service === 'inspect') return inspect.serve(method, args)
    if (service === 'debug' && method === 'eval' && debug) return await (0, eval)(String(args[0]))
    if (service === 'debug' && method === 'stats' && debug) return dom.stats(Boolean(args[0]))
    throw new Error(`${init.name} serves no ${service}.${method}`)
  })
  listeners.push((message) => {
    if (Rpc.handles(message)) return
    const m = message as { type?: string; events?: unknown[]; dark?: boolean; language?: string; languages?: string[]; width?: number; height?: number }
    if (m.type === 'events' && Array.isArray(m.events)) web.deliver(m.events as never)
    if (m.type === 'screen' && m.width && m.height) page.setScreen({ width: m.width, height: m.height })
    if (m.type === 'languages') page.setLanguages({ language: m.language, languages: m.languages })
    if (m.type === 'colorscheme') {
      dom.setDark?.(m.dark === true)
      page.mediaChanged()
    }
  })
  if (self) {
    self.emit('activate')
    self.onVisible = (visible) => page.setVisible(visible)
  }
  new PageCalls(page, rpc, init.name)
  web.onActivation = (active) => self?.emit(active ? 'activate' : 'deactivate')
  web.onGrab = (event) => self?.emit(event.kind === 'lost' ? 'grablost' : 'grab', event)
  if (init.kind === 'desktop') {
    web.onFirstFrame = () => void rpc.call('page', 'shown').catch(() => undefined)
    const pinned = new Pinned(rpc, surface, dom, page as never)
    web.onPanelMove = (id, extent) => pinned.extend(id, extent)
    bridge.value['desktop'] = { ...(bridge.value['desktop'] as object), pin: (element: Element, options?: { margin?: number }) => pinned.pin(element, options) }
  }
  if (natives.fs) bridge.value['fs'] = natives.fs
  if (natives.terminal) bridge.value['terminal'] = natives.terminal
  if (natives.network) bridge.value['network'] = natives.network
  if (natives.office) bridge.value['office'] = { ...natives.office, editorPage: async (setup: { api: string; config: unknown }, theme: 'light' | 'dark') => OfficePage.write(setup, theme) }
  bridge.define(host)
  const app = self ? new WebAppPage(page, rpc, init.name, self.api, storage) : null
  StartupTimeline.mark('page load started')
  const served = htmlEntry && PageSource.isServer(init.app!.entry)
  const html = init.kind === 'desktop' ? (init.standalone ? standalone(init.standalone) : readFileSync(init.page!, 'utf8')) : served ? await PageSource.served(page.window as never, init.url ?? `${PageSource.ORIGIN}/`) : htmlPage ? PageSource.html(htmlPage, init.resources) : PageSource.window(init.app!, init.theme ?? '')
  await page.loadPage(html)
  if (self && init.app!.frame !== false) {
    const frame = new WindowFrame(page as never, self.api, init.app!.label)
    self.onTitle = (title) => frame.title(title)
    if (app) app.onTitle = (title) => frame.title(title)
    frame.install()
  }
  app?.loaded(htmlEntry)
  StartupTimeline.mark(init.kind === 'desktop' ? 'desktop loaded' : 'loaded')
  await web.run(surface)
  storage?.flush()
  web.close()
  process.exit(0)
}

function standalone(app: string): string {
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><title>${PageSource.escape(app)}</title><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #2b2733; }
</style></head><body></body></html>`
}
