import { install, installBackendTransport, type AudioNative, type BackendTransport, type DomNative, type GpuNative, type HostNative } from '@dopame/acde-dom'
import type { IsolateInit } from './broker'
import { Host } from './host'
import type { ImeEvent, NativeIme } from './ime'
import type { NativeSurface, OwnFiles } from './native'
import { PageSource } from './page'
import { PageCalls } from './pagecalls'
import { PageInspect } from './pageinspect'
import { Pinned } from './pinned'
import { Modules, WindowList, WindowSelf } from './modules'
import { ServiceBinding } from './binding'
import type { DeskMessage, IsolateDesk, IsolateServices } from './desk'
import { StorageFile, type StorageStore } from './storage'
import { OfficePage } from './office'
import { bindNatives, type Natives } from './sys/natives'
import { StartupTimeline } from './timeline'
import { AppPage } from './apppage'
import type { WindowFrameContext } from '@dopame/acde-api'
import { Level, Log } from './log'

interface IsolateNatives extends Natives {
  readonly host: HostNative & { onTaskEnd(fn: () => void): void; setReporter(fn: (error: unknown, promise?: Promise<unknown>) => void): void; requestFrame(): void }
  readonly desk: IsolateDesk
  readonly services: IsolateServices
  readonly init: IsolateInit
  readonly env: Record<string, string>
  readonly own: Own
  createDocument(width: number, height: number, scale: number, options: { resources: { prefix: string; dirs: string[] }[]; reducedMotion: boolean; dark: boolean }): DomNative
  claimSurface(): NativeSurface
  readonly Ime?: new (callback: (event: ImeEvent) => void) => NativeIme
  readonly gpu?: GpuNative
  readonly audio?: AudioNative
  readonly backend?: Omit<BackendTransport, 'port'>
  readonly fs?: object
  readonly terminal?: object
  readonly network?: object
  readonly system?: object
  readonly sound?: { watch(callback: (state: unknown) => void): void }
  readonly power?: { watch(callback: (event: { type: string }) => void): void }
  readonly bluetooth?: BluetoothNatives
  readonly office?: { writePage(key: string, html: string): string }
}

/** What a desktop or window isolate has of its own (crates/acde `own.rs`): ending itself, its storage file, the files the user handed it. */
interface Own {
  exit(code: number): never
  readonly storage?: Omit<StorageStore, 'name'>
  readonly files: OwnFiles
}

export default async function boot(natives: IsolateNatives): Promise<void> {
  bindNatives(natives)
  const { host, desk, init } = natives
  Host.label = init.name

  const dom = natives.createDocument(init.width, init.height, init.scale, { resources: init.resources, reducedMotion: init.reducedMotion === true, dark: init.dark === true })
  const surface = natives.claimSurface()
  host.requestFrame = () => surface.requestFrame()

  const storage = natives.own.storage ? new StorageFile({ name: `${init.name} storage`, ...natives.own.storage }) : null
  const htmlEntry = init.place === 'window' && !!init.app && PageSource.isHtml(init.app.entry)
  const asset = (path: string): string | null => {
    const bytes = host.readAsset(`${PageSource.ORIGIN}${path}`)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
  const htmlPage = htmlEntry ? PageSource.htmlFor(init.app!.entry, init.url, (path) => asset(path) !== null) : null
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

  const binding = new ServiceBinding({ postMessage: (message) => natives.services.post(message), on: (_event, listener) => natives.services.onMessage(listener) })
  const self = init.place === 'window' && init.app ? new WindowSelf(desk, surface, globalThis as never, init.request ?? null) : null
  const windows = new WindowList(desk)
  const modules = new Modules(binding, desk, init, self, windows)
  if (init.place === 'window' && init.app?.backend && natives.backend) installBackendTransport({ ...natives.backend, port: init.app.backend.port })
  const pageHost = new Host(page, dom, init.scale, natives.Ime, windows, natives.own.files)
  const debug = !!natives.env['ACDE_DEBUG_DIR']
  const inspect = new PageInspect(page, dom, pageHost)
  desk.onAsk(async (kind, payload) => {
    switch (kind) {
      case 'beforeclose':
        return self ? self.beforeClose() : true
      case 'request':
        return self?.deliver(payload as Record<string, unknown>)
      case 'menu': {
        const [menu, item] = payload as [string, string]
        return self?.menu(String(menu), String(item))
      }
      case 'inspect': {
        const { method, args } = payload as { method: string; args: unknown[] }
        try {
          return await inspect.serve(method, args)
        } catch (error) {
          return { error: String((error as Error)?.message ?? error) }
        }
      }
      case 'debug.eval':
        return debug ? await (0, eval)(String(payload)) : null
      case 'debug.stats':
        return debug ? dom.stats(Boolean(payload)) : null
    }
  })
  desk.onMessage((m: DeskMessage) => {
    switch (m.type) {
      case 'events':
        return pageHost.deliver(m.events as never)
      case 'screen':
        return page.setScreen({ width: m.width, height: m.height })
      case 'languages':
        return page.setLanguages({ language: m.language, languages: m.languages })
      case 'colorscheme':
        dom.setDark?.(m.dark === true)
        return page.mediaChanged()
      case 'display':
        return modules.displayChanged(m.state)
      case 'visible':
        self?.visible(m.visible === true)
        return self?.onVisible(m.visible)
    }
  })
  if (self) {
    self.emit('activate')
    self.onVisible = (visible) => page.setVisible(visible)
  }
  new PageCalls(page, desk, init.name, init.app?.label ?? '桌面', natives.own.files)
  pageHost.onActivation = (active) => self?.emit(active ? 'activate' : 'deactivate')
  pageHost.onGrab = (event) => self?.emit(event.kind === 'lost' ? 'grablost' : 'grab', event)
  pageHost.onMode = (mode) => self?.mode(mode)
  if (init.place === 'desktop') {
    pageHost.onFirstFrame = () => desk.shown()
    const pinned = new Pinned(desk, surface, dom, page as never)
    pageHost.onPanelMove = (id, extent) => pinned.extend(id, extent)
    type Reserve = { edge: 'top' | 'bottom' | 'left' | 'right'; thickness: number }
    const pin = (element: Element, options?: { margin?: number; reserve?: Reserve }) => {
      const panel = pinned.pin(element, options)
      windows.reserve(element, options?.reserve ?? null)
      return {
        ...panel,
        unpin: () => {
          windows.reserve(element, null)
          panel.unpin()
        },
        reserve: (reserve: Reserve | null) => windows.reserve(element, reserve ?? null),
      }
    }
    modules.value['desktop'] = { ...(modules.value['desktop'] as object), pin }
  }
  if (natives.fs) modules.value['fs'] = natives.fs
  if (natives.terminal) modules.value['terminal'] = natives.terminal
  if (natives.network) modules.value['network'] = natives.network
  if (natives.system) modules.value['system'] = systemModule(natives.system)
  if (natives.sound) modules.value['audio'] = audioModule(natives.sound)
  if (natives.power) modules.value['power'] = powerModule(natives.power)
  if (natives.bluetooth) modules.value['bluetooth'] = bluetoothModule(natives.bluetooth)
  const office = natives.office
  if (office) modules.value['office'] = { ...office, editorPage: async (setup: { api: string; config: unknown }, theme: 'light' | 'dark') => office.writePage(...OfficePage.page(setup, theme)) }
  modules.define(host)
  const app = self ? new AppPage(page, desk, init.name, self.api, storage) : null
  StartupTimeline.mark('page load started')
  const served = htmlEntry && PageSource.isServer(init.app!.entry)
  const html = init.place === 'desktop' ? (init.standalone ? standalone(init.standalone) : init.html!) : served ? await PageSource.served(page.window as never, init.url ?? `${PageSource.ORIGIN}/`) : htmlPage ? PageSource.html(htmlPage, asset(htmlPage) ?? '') : PageSource.window(init.app!, init.theme ?? '')
  await page.loadPage(html)
  if (self && init.frame) await installFrame(init.frame, init.frameStyle ?? null, self, app, page.window as never, init.app!)
  app?.loaded(htmlEntry)
  StartupTimeline.mark(init.place === 'desktop' ? 'desktop loaded' : 'loaded')
  await pageHost.run(surface)
  storage?.flush()
  pageHost.close()
  natives.own.exit(0)
}

/** The desktop's window frame (its manifest's `frame` module): acde draws none of its own. */
async function installFrame(url: string, style: 'mac' | 'windows' | null, self: WindowSelf, app: AppPage | null, window: { document: Document }, manifest: { id: string; label: string; icon: string }): Promise<void> {
  let title = manifest.label
  const handlers: ((title: string) => void)[] = []
  const changed = (next: string) => {
    title = next
    for (const handler of handlers) handler(next)
  }
  self.onTitle = changed
  if (app) app.onTitle = changed
  try {
    const module = (await import(new URL(url, PageSource.ORIGIN).href)) as { default?: (context: WindowFrameContext) => unknown }
    await module.default?.({
      window: self.api as unknown as WindowFrameContext['window'],
      document: window.document,
      app: { id: manifest.id, label: manifest.label, icon: manifest.icon },
      style,
      get title() {
        return title
      },
      onTitle: (handler) => void handlers.push(handler),
    })
  } catch (error) {
    Log.write(Level.Warn, 'acde_host', `window frame ${url}: ${(error as Error)?.message ?? String(error)}`)
  }
}

function powerModule(natives: { watch(callback: (event: { type: string }) => void): void }): object {
  const EVENTS = ['changed', 'prompt', 'critical']
  const handlers = new Map<string, Set<(value: unknown) => void>>()
  let watching = false
  const { watch: _, ...methods } = natives
  return {
    ...methods,
    on(type: string, handler: unknown): () => boolean {
      if (!EVENTS.includes(type)) throw new TypeError(`acde:power has no ${String(type)} event`)
      if (typeof handler !== 'function') throw new TypeError('acde:power on: the handler is not a function')
      if (!watching) {
        watching = true
        natives.watch((event) => {
          const value = event.type === 'changed' ? (event as { state?: unknown }).state : event
          for (const h of handlers.get(event.type) ?? []) {
            try {
              h(value)
            } catch (error) {
              reportError(error)
            }
          }
        })
      }
      let set = handlers.get(type)
      if (!set) handlers.set(type, (set = new Set()))
      const own = (value: unknown) => (handler as (value: unknown) => void)(value)
      set.add(own)
      return () => set.delete(own)
    },
  }
}

function systemModule(natives: object): object {
  return {
    ...natives,
    on(type: string, handler: unknown): () => void {
      if (type !== 'changed') throw new TypeError(`acde:system has no ${String(type)} event`)
      if (typeof handler !== 'function') throw new TypeError('acde:system on: the handler is not a function')
      return () => {}
    },
  }
}

function audioModule(natives: { watch(callback: (state: unknown) => void): void }): object {
  const { watch, ...methods } = natives
  const handlers = new Set<(state: unknown) => void>()
  let watching = false
  return {
    ...methods,
    on(type: string, handler: unknown): () => boolean {
      if (type !== 'changed') throw new TypeError(`acde:audio has no ${String(type)} event`)
      if (typeof handler !== 'function') throw new TypeError('acde:audio on: the handler is not a function')
      const fn = handler as (state: unknown) => void
      handlers.add(fn)
      if (!watching) {
        watching = true
        watch((state) => {
          for (const each of [...handlers]) {
            try {
              each(state)
            } catch (error) {
              Log.write(Level.Error, 'acde_host', `acde:audio changed: ${(error as Error)?.message ?? String(error)}`)
            }
          }
        })
      }
      return () => handlers.delete(fn)
    },
  }
}

interface BluetoothNatives {
  watch(callback: (state: unknown) => void): void
  pairing(callback: ((request: unknown) => void) | null): void
}

function bluetoothModule(natives: BluetoothNatives): object {
  const { watch, pairing, ...methods } = natives
  const changed = new Set<(value: unknown) => void>()
  const asks = new Set<(value: unknown) => void>()
  let watching = false
  const each = (type: string, handlers: Set<(value: unknown) => void>, value: unknown) => {
    for (const handler of [...handlers]) {
      try {
        handler(value)
      } catch (error) {
        Log.write(Level.Warn, 'acde_host', `acde:bluetooth ${type} handler: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }
  return {
    ...methods,
    on(type: string, handler: unknown): () => boolean {
      if (type !== 'changed' && type !== 'pairing') throw new TypeError(`acde:bluetooth has no ${String(type)} event`)
      if (typeof handler !== 'function') throw new TypeError('acde:bluetooth on: the handler is not a function')
      const fn = handler as (value: unknown) => void
      if (type === 'changed') {
        if (!watching) {
          watching = true
          watch((state) => each(type, changed, state))
        }
        changed.add(fn)
        return () => changed.delete(fn)
      }
      if (!asks.size) pairing((request) => each(type, asks, request))
      asks.add(fn)
      return () => {
        const had = asks.delete(fn)
        if (had && !asks.size) pairing(null)
        return had
      }
    },
  }
}

function standalone(app: string): string {
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><title>${PageSource.escape(app)}</title><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #2b2733; }
</style></head><body></body></html>`
}
