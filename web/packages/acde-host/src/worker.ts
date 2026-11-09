import { install, installBackendTransport, observe, type AudioNative, type BackendTransport, type DomNative, type GpuNative, type HostNative } from '@dopame/acde-dom'
import type { WebInit } from './broker'
import { Frame } from './frame'
import { Host } from './host'
import type { ImeEvent, NativeIme } from './ime'
import type { NativeSurface } from './native'
import { DevHot } from './devhot'
import { DevRoutes, type DevRoute } from './devroutes'
import { DevState, type DevSnapshot } from './devstate'
import { Level, Log } from './log'
import { PageSource } from './page'
import { PageCalls, type FolderPicker } from './pagecalls'
import { PageInspect } from './pageinspect'
import { Pinned } from './pinned'
import { RemoteBridge, WindowList, WindowSelf } from './remote'
import { Rpc } from './rpc'
import { StorageFile } from './storage'
import { OfficePage } from './office'
import { readFileSync, readTextOr } from './sys/fs'
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
  claimSurface(token: bigint, options?: { frame?: number }): NativeSurface
  readonly Ime?: new (callback: (event: ImeEvent) => void) => NativeIme
  readonly gpu?: GpuNative
  readonly audio?: AudioNative
  readonly backend?: Omit<BackendTransport, 'port'>
  readonly fs?: object
  readonly terminal?: object
  readonly network?: object
  readonly office?: object
  readonly picker?: FolderPicker
}

export default async function boot(natives: WebNatives): Promise<void> {
  bindNatives(natives)
  const { host, port, init } = natives
  Host.label = init.name

  const dom = natives.createDocument(init.width, init.height, init.scale, { resources: init.resources, reducedMotion: init.reducedMotion === true, dark: init.dark === true })
  const surface = natives.claimSurface(init.token, { frame: init.kind === 'window' ? Frame.height(init.app) : 0 })
  const title = (text: string) => surface.setTitle(text || (init.app?.label ?? init.name))
  title('')
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
    localStorage: storage?.read() ?? null,
    onStorageChange: storage ? (entries) => storage.changed(entries) : undefined,
    gpu: natives.gpu,
    audio: natives.audio,
    ...(init.screen && { screen: init.screen }),
  })
  const routes = natives.env['ACDE_DEV'] ? new DevRoutes(init.devRoutes ?? [], (id) => port.post({ devroute: id })) : null
  if (routes) {
    observe({
      console: (level, text) => port.post({ devlog: 'console', time: Log.clock(), level, text }),
      error: (kind, text) => port.post({ devlog: 'error', time: Log.clock(), kind, text }),
      request: (event) => port.post({ devlog: 'request', time: Log.clock(), event }),
      route: (_kind, method, url) => routes.match(method, url),
    })
  }
  host.onTaskEnd(() => page.endTask())
  host.setReporter((error, promise) => {
    if (promise) page.unhandledRejection(promise, error)
    else page.reportError(error)
  })

  const rpc = new Rpc((message) => port.post(message))
  const self = init.kind === 'window' && init.app ? new WindowSelf(rpc, surface, globalThis as never, init.request ?? null) : null
  const windows = new WindowList(rpc)
  const bridge = new RemoteBridge(rpc, init, self, windows)
  if (natives.backend) installBackendTransport({ ...natives.backend, port: init.kind === 'window' && init.app?.backend ? init.app.backend.port : null })
  const web = new Host(page, dom, init.scale, natives.Ime, windows)
  const debug = !!natives.env['ACDE_DEBUG_DIR'] || !!natives.env['ACDE_DEV']
  const inspect = new PageInspect(page, dom, web, surface.contentOffset)
  rpc.serve(async (service, method, args) => {
    if (service === 'window' && self) return self.serve(method, args)
    if (service === 'inspect') return inspect.serve(method, args)
    if (service === 'dev' && method === 'state' && natives.env['ACDE_DEV']) return DevState.capture(page.window as never)
    if (service === 'debug' && method === 'eval' && debug) return await (0, eval)(String(args[0]))
    if (service === 'debug' && method === 'stats' && debug) return dom.stats(Boolean(args[0]))
    throw new Error(`${init.name} serves no ${service}.${method}`)
  })
  let devhot = (): void => {}
  port.onMessage((message) => {
    if (rpc.receive(message)) return
    const m = message as { type?: string; dark?: boolean; reduced?: boolean; language?: string; languages?: string[]; width?: number; height?: number; routes?: DevRoute[] }
    switch (m.type) {
      case 'devroutes':
        return routes?.set(m.routes ?? [])
      case 'screen':
        if (m.width && m.height) page.setScreen({ width: m.width, height: m.height })
        return
      case 'languages':
        return page.setLanguages({ language: m.language, languages: m.languages })
      case 'colorscheme':
        dom.setDark?.(m.dark === true)
        return page.mediaChanged()
      case 'motion':
        dom.setReducedMotion?.(m.reduced === true)
        return page.mediaChanged()
      case 'devhot':
        return devhot()
      default:
        web.deliver([m] as never)
    }
  })
  if (self) {
    self.emit('activate')
    self.onVisible = (visible) => page.setVisible(visible)
  }
  new PageCalls(page, rpc, init.name, { picker: natives.picker ?? null, label: init.app?.label ?? '桌面' })
  web.onActivation = (active) => self?.emit(active ? 'activate' : 'deactivate')
  web.onGrab = (event) => self?.emit(event.kind === 'lost' ? 'grablost' : 'grab', event)
  web.onFrameButton = (key) => {
    if (!self) return
    if (key === 'close') void self.api.close()
    else if (key === 'minimize') void self.api.minimize()
    else if (key === 'fullscreen' || key === 'restore') self.api.requestMode(key === 'fullscreen' ? 'fullscreen' : 'free')
  }
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
  if (init.devState) {
    DevState.restore(page.window as never, init.devState as DevSnapshot, (restored, missed) =>
      Log.write(Level.Info, 'acde_host', `[${init.name}] acde dev: state restored (${restored} kept${missed ? `, ${missed} not found` : ''})`),
    )
  }
  const reread = !natives.env['ACDE_DEV'] ? null : init.kind === 'desktop' ? (init.standalone ? null : () => readFileSync(init.page!, 'utf8')) : !served && htmlPage ? () => PageSource.html(htmlPage, init.resources) : null
  const hot = reread
    ? new DevHot(page.window.document as never, (page.window as never as { DOMParser: ConstructorParameters<typeof DevHot>[1] }).DOMParser, page.window.location.href, {
        read: (src) => {
          const path = new URL(src, PageSource.ORIGIN).pathname
          const file = PageSource.file(path, init.resources ?? [])
          return file ? readTextOr(file, null) : null
        },
        liveEdit: (url, source) => (host.liveEdit ? host.liveEdit(url, source) : 'no live edit here'),
      }, html)
    : null
  devhot = () => {
    let why: string | null = 'no page source to reread'
    try {
      if (hot && reread) why = hot.apply(reread())
    } catch (error) {
      why = (error as Error).message
    }
    Log.write(Level.Info, 'acde_host', `[${init.name}] acde dev: ${why === null ? 'hot swapped in place' : `reloading (${why})`}`)
    if (why !== null) void rpc.call('page', 'devreload').catch(() => undefined)
  }
  title(page.window.document.title ?? '')
  if (self) self.onTitle = title
  if (app) app.onTitle = title
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
