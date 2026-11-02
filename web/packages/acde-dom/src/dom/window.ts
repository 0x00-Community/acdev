import { defineHandlers, Event, EventTarget, fire, LISTENERS, windowEvent } from '../core/event'
import { DOMException } from '../core/exception'
import { G, globals, host, tag } from '../core/host'
import { structuredClone } from '../core/message'
import { objectUrls, URL } from '../core/url'
import { Blob } from '../core/blob'
import { NONE, NodeType } from '../native'
import type { Element } from './element'
import { scrollElement } from './element'
import { env, frames, resolveUrl } from './env'
import { HashChangeEvent, MediaQueryListEvent, PopStateEvent } from './events'
import { HANDLER_TYPES } from './element'
import { linkHooks } from './html'
import { metricsOf } from './layout'
import { FileSystemFileHandle, FileSystemHandle, FileSystemWritableFileStream, showOpenFilePicker, showSaveFilePicker } from './picker'
import { documentId, dom, ID, rootElementId, wrap } from './realm'
import { computedStyle, type CSSStyleDeclaration } from './style'

export const viewport = { width: 0, height: 0, scale: 1 }

export function readViewport(): void {
  const v = dom.viewport()
  viewport.width = v.width
  viewport.height = v.height
  viewport.scale = v.scale
}

function rootElement(): Element | null {
  return wrap<Element>(rootElementId())
}

export class Window extends EventTarget {}
tag(Window)

const WINDOW_HANDLERS = ['afterprint', 'beforeprint', 'beforeunload', 'hashchange', 'languagechange', 'message', 'messageerror', 'offline', 'online', 'pagehide', 'pageshow', 'popstate', 'rejectionhandled', 'storage', 'unhandledrejection', 'unload', 'devicemotion', 'deviceorientation']

function sameDocument(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.username === b.username && a.password === b.password
}

interface Entry {
  url: string
  state: unknown
}

const entries: Entry[] = []
let index = 0
let parsedFrom = ''
let parsed: URL | null = null

function here(): URL {
  if (parsedFrom !== env.url || !parsed) {
    parsed = new URL(env.url)
    parsedFrom = env.url
  }
  return parsed
}

function navigate(url: string, replace: boolean): void {
  const next = new URL(url, env.url)
  const now = here()
  if (saves(next.href)) return saveUrl(next.href, '')
  if (!sameDocument(next, now) || (next.hash === now.hash && next.href !== now.href)) {
    env.navigate(next.href, '_self')
    return
  }
  if (next.href === now.href) return void (next.hash && scrollToFragment(next.hash))
  const oldURL = env.url
  env.url = next.href
  if (replace) entries[index] = { url: env.url, state: null }
  else {
    entries.splice(index + 1)
    entries.push({ url: env.url, state: null })
    index = entries.length - 1
  }
  if (next.hash !== now.hash) {
    scrollToFragment(next.hash)
    host.setTimer(0, () => {
      fire(G as unknown as EventTarget, new HashChangeEvent('hashchange', { oldURL, newURL: next.href }))
    })
  }
}

function saves(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:')
}

function saveUrl(url: string, name: string): void {
  if (!env.download) return void host.print(1, `acde-dom: not saved (no downloads here): ${url.slice(0, 120)}`)
  const blob = url.startsWith('blob:') ? objectUrls.get(url) : undefined
  env.download({ url, name, ...(blob instanceof Blob ? { blob } : {}) })
}

function followLink(url: string, target: string, download: string | null): void {
  let next: URL
  try {
    next = new URL(url, env.url)
  } catch {
    return
  }
  if (download !== null && (saves(next.href) || next.origin === here().origin)) return saveUrl(next.href, download)
  const where = target.trim().toLowerCase()
  if (where && where !== '_self' && where !== '_parent' && where !== '_top') {
    if (saves(next.href)) return saveUrl(next.href, '')
    return env.navigate(next.href, target)
  }
  navigate(next.href, false)
}

function scrollToFragment(hash: string): void {
  let fragment = hash.replace(/^#/, '')
  try {
    fragment = decodeURIComponent(fragment)
  } catch {
  }
  let id = fragment ? dom.getElementById(fragment) : NONE
  if (id === NONE && fragment) id = dom.querySelectorAll(documentId, 'a[name]').find((a) => dom.getAttribute(a, 'name') === fragment) ?? NONE
  if (id !== NONE) return (wrap<Element>(id) as unknown as { scrollIntoView(options: object): void }).scrollIntoView({ block: 'start' })
  if (!fragment || fragment.toLowerCase() === 'top') scrollViewport(0, 0, false)
}

export class Location {
  get href(): string {
    return env.url
  }
  set href(value: string) {
    navigate(String(value), false)
  }
  get origin(): string {
    return here().origin
  }
  get protocol(): string {
    return here().protocol
  }
  set protocol(_value: string) {}
  get host(): string {
    return here().host
  }
  set host(_value: string) {}
  get hostname(): string {
    return here().hostname
  }
  set hostname(_value: string) {}
  get port(): string {
    return here().port
  }
  set port(_value: string) {}
  get pathname(): string {
    return here().pathname
  }
  set pathname(value: string) {
    const u = new URL(env.url)
    u.pathname = String(value)
    navigate(u.href, false)
  }
  get search(): string {
    return here().search
  }
  set search(value: string) {
    const u = new URL(env.url)
    u.search = String(value)
    navigate(u.href, false)
  }
  get hash(): string {
    return here().hash
  }
  set hash(value: string) {
    const u = new URL(env.url)
    const v = String(value)
    u.hash = v.startsWith('#') ? v.slice(1) : v
    navigate(u.href, false)
  }
  get ancestorOrigins(): { length: number } {
    return { length: 0 }
  }
  assign(url: string): void {
    navigate(String(url), false)
  }
  replace(url: string): void {
    navigate(String(url), true)
  }
  reload(): void {
    env.reload()
  }
  toString(): string {
    return env.url
  }
  valueOf(): this {
    return this
  }
}
tag(Location)

export class History {
  scrollRestoration = 'auto'

  get length(): number {
    return entries.length
  }
  get state(): unknown {
    return entries[index]?.state ?? null
  }

  #url(url: string | URL | null | undefined): string {
    if (url === null || url === undefined) return env.url
    const next = new URL(String(url), env.url)
    if (next.origin !== here().origin) throw new DOMException(`Failed to execute 'pushState' on 'History': A history state object with URL '${next.href}' cannot be created in a document with origin '${here().origin}'.`, 'SecurityError')
    return next.href
  }

  pushState(state: unknown, _unused: string, url?: string | URL | null): void {
    const href = this.#url(url)
    entries.splice(index + 1)
    entries.push({ url: href, state: structuredClone(state) })
    index = entries.length - 1
    env.url = href
  }

  replaceState(state: unknown, _unused: string, url?: string | URL | null): void {
    const href = this.#url(url)
    entries[index] = { url: href, state: structuredClone(state) }
    env.url = href
  }

  go(delta = 0): void {
    if (delta === 0) return env.reload()
    const target = index + Math.trunc(delta)
    if (target < 0 || target >= entries.length) return
    host.setTimer(0, () => {
      const oldURL = env.url
      index = target
      const entry = entries[index]!
      env.url = entry.url
      fire(G as unknown as EventTarget, new PopStateEvent('popstate', { state: entry.state }))
      if (new URL(oldURL).hash !== new URL(entry.url).hash) {
        if (entry.state === null) scrollToFragment(new URL(entry.url).hash)
        fire(G as unknown as EventTarget, new HashChangeEvent('hashchange', { oldURL, newURL: entry.url }))
      }
    })
  }

  back(): void {
    this.go(-1)
  }

  forward(): void {
    this.go(1)
  }
}
tag(History)

const STORAGE = Symbol('storage')

export class Storage {
  [STORAGE]: Map<string, string> = new Map()
  onChange: (() => void) | null = null

  get length(): number {
    return this[STORAGE].size
  }
  key(index: number): string | null {
    return [...this[STORAGE].keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this[STORAGE].get(String(key)) ?? null
  }
  setItem(key: string, value: string): void {
    const k = String(key), v = String(value)
    if (this[STORAGE].get(k) === v) return
    this[STORAGE].set(k, v)
    this.onChange?.()
  }
  removeItem(key: string): void {
    if (this[STORAGE].delete(String(key))) this.onChange?.()
  }
  clear(): void {
    if (this[STORAGE].size === 0) return
    this[STORAGE].clear()
    this.onChange?.()
  }
}
tag(Storage)

export function storage(initial: Record<string, string> | null | undefined): Storage {
  const target = new Storage()
  for (const [k, v] of Object.entries(initial ?? {})) if (typeof v === 'string') target[STORAGE].set(k, v)
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'symbol' || key in t) return Reflect.get(t, key)
      return t.getItem(key) ?? undefined
    },
    set(t, key, value) {
      if (typeof key === 'symbol' || key === 'onChange') return Reflect.set(t, key, value)
      t.setItem(key, value)
      return true
    },
    deleteProperty(t, key) {
      if (typeof key === 'string') t.removeItem(key)
      return true
    },
    has(t, key) {
      return typeof key === 'string' ? t[STORAGE].has(key) || key in t : key in t
    },
    ownKeys(t) {
      return [...t[STORAGE].keys()]
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key !== 'string' || !t[STORAGE].has(key)) return undefined
      return { value: t[STORAGE].get(key), writable: true, enumerable: true, configurable: true }
    },
  })
}

export function storageEntries(s: Storage): Record<string, string> {
  return Object.fromEntries((s as unknown as { [STORAGE]: Map<string, string> })[STORAGE] ?? new Map())
}

const watched = new Set<MediaQueryList>()
let recheckList: (list: MediaQueryList) => void

export class MediaQueryList extends EventTarget {
  readonly #media: string
  #last: boolean | null = null

  constructor(media: string) {
    super()
    this.#media = media
  }

  get media(): string {
    return this.#media
  }

  get matches(): boolean {
    const now = dom.matchMedia(this.#media)
    this.#last = now
    return now
  }

  override addEventListener(type: string, callback: unknown, options?: unknown): void {
    if (type === 'change') {
      if (this.#last === null) this.#last = dom.matchMedia(this.#media)
      watched.add(this)
    }
    super.addEventListener(type, callback, options)
  }

  override removeEventListener(type: string, callback: unknown, options?: unknown): void {
    super.removeEventListener(type, callback, options)
    if (!this[LISTENERS]?.has('change')) watched.delete(this)
  }

  addListener(callback: unknown): void {
    this.addEventListener('change', callback)
  }

  removeListener(callback: unknown): void {
    this.removeEventListener('change', callback)
  }

  get onchange(): unknown {
    return this.#onchange
  }
  set onchange(value: unknown) {
    if (this.#onchange) this.removeEventListener('change', this.#onchange)
    this.#onchange = typeof value === 'function' ? value : null
    if (this.#onchange) this.addEventListener('change', this.#onchange)
  }
  #onchange: unknown = null

  static {
    recheckList = (list) => {
      if (!list[LISTENERS]?.has('change')) return void watched.delete(list)
      const now = dom.matchMedia(list.#media)
      if (now === list.#last) return
      list.#last = now
      fire(list, new MediaQueryListEvent('change', { media: list.#media, matches: now }))
    }
  }
}
tag(MediaQueryList)

export function mediaChanged(): void {
  for (const list of [...watched]) recheckList(list)
}

let nextFrame = 1
let pending = new Map<number, (time: number) => void>()

export function requestAnimationFrame(callback: (time: number) => void): number {
  if (typeof callback !== 'function') throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': The callback provided as parameter 1 is not a function.")
  const id = nextFrame++
  pending.set(id, callback)
  frames.request()
  return id
}

export function cancelAnimationFrame(id: number): void {
  pending.delete(id)
}

export function runAnimationFrames(time: number, report: (error: unknown) => void): void {
  if (pending.size === 0) return
  const batch = pending
  pending = new Map()
  for (const callback of batch.values()) {
    try {
      callback(time)
    } catch (error) {
      report(error)
    }
  }
}

export function framesPending(): boolean {
  return pending.size > 0
}

export class Clipboard extends EventTarget {
  readText(): Promise<string> {
    return env.clipboard ? env.clipboard.readText() : Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'))
  }
  writeText(text: string): Promise<void> {
    return env.clipboard ? env.clipboard.writeText(String(text)) : Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))
  }
  read(): Promise<unknown[]> {
    return Promise.reject(new DOMException('Clipboard items are not supported', 'NotAllowedError'))
  }
  write(): Promise<void> {
    return Promise.reject(new DOMException('Clipboard items are not supported', 'NotAllowedError'))
  }
}
tag(Clipboard)

export class MediaDevices extends EventTarget {
  getUserMedia(): Promise<never> {
    return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  }
  getDisplayMedia(): Promise<never> {
    return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  }
  enumerateDevices(): Promise<unknown[]> {
    return Promise.resolve([])
  }
  getSupportedConstraints(): object {
    return {}
  }
}
tag(MediaDevices)

export class Notification extends EventTarget {
  static get permission(): string {
    return env.notify ? 'granted' : 'denied'
  }
  static get maxActions(): number {
    return 0
  }
  static requestPermission(callback?: (permission: string) => void): Promise<string> {
    const permission = env.notify ? 'granted' : 'denied'
    if (typeof callback === 'function') host.setTimer(0, () => callback(permission))
    return Promise.resolve(permission)
  }

  readonly title: string
  readonly body: string
  readonly tag: string
  readonly icon: string
  readonly data: unknown

  constructor(title: string, options: { body?: string; tag?: string; icon?: string; data?: unknown } = {}) {
    super()
    if (arguments.length === 0) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.")
    this.title = String(title)
    this.body = String(options?.body ?? '')
    this.tag = String(options?.tag ?? '')
    this.icon = options?.icon ? resolveUrl(String(options.icon)) : ''
    this.data = options?.data ?? null
    const notify = env.notify
    if (notify) notify({ title: this.title, body: this.body, icon: this.icon, tag: this.tag })
    host.setTimer(0, () => fire(this, new Event(notify ? 'show' : 'error')))
  }

  close(): void {}
}
defineHandlers(Notification.prototype, ['click', 'close', 'error', 'show'])
tag(Notification)

export interface NavigatorOptions {
  readonly language?: string
  readonly languages?: readonly string[]
  readonly hardwareConcurrency?: number
  readonly userAgent?: string
}

const navigatorLanguages = new WeakMap<Navigator, { language?: string; languages?: readonly string[] }>()

export function setNavigatorLanguages(navigator: Navigator, languages: { language?: string; languages?: readonly string[] }): boolean {
  const before = navigatorLanguages.get(navigator) ?? {}
  if (before.language === languages.language && (before.languages ?? []).join() === (languages.languages ?? []).join()) return false
  navigatorLanguages.set(navigator, { language: languages.language, languages: languages.languages ? [...languages.languages] : undefined })
  return true
}

export class Navigator {
  readonly #options: NavigatorOptions
  readonly #clipboard = new Clipboard()
  readonly #media = new MediaDevices()

  constructor(options: NavigatorOptions) {
    this.#options = options
    navigatorLanguages.set(this, { language: options.language, languages: options.languages })
  }

  get userAgent(): string {
    return this.#options.userAgent ?? 'Mozilla/5.0 (Linux; Wayland) AppleWebKit/537.36 (KHTML, like Gecko) acde/0.1'
  }
  get appVersion(): string {
    return this.userAgent.replace(/^Mozilla\//, '')
  }
  get appName(): string {
    return 'Netscape'
  }
  get appCodeName(): string {
    return 'Mozilla'
  }
  get platform(): string {
    return 'Linux x86_64'
  }
  get product(): string {
    return 'Gecko'
  }
  get productSub(): string {
    return '20030107'
  }
  get vendor(): string {
    return ''
  }
  get vendorSub(): string {
    return ''
  }
  get language(): string {
    return navigatorLanguages.get(this)?.language ?? this.languages[0] ?? 'zh-CN'
  }
  get languages(): readonly string[] {
    return Object.freeze([...(navigatorLanguages.get(this)?.languages ?? ['zh-CN', 'zh', 'en'])])
  }
  get onLine(): boolean {
    return true
  }
  get cookieEnabled(): boolean {
    return true
  }
  get hardwareConcurrency(): number {
    return this.#options.hardwareConcurrency ?? 4
  }
  get deviceMemory(): number {
    return 8
  }
  get maxTouchPoints(): number {
    return 0
  }
  get pdfViewerEnabled(): boolean {
    return false
  }
  get webdriver(): boolean {
    return false
  }
  get doNotTrack(): null {
    return null
  }
  get clipboard(): Clipboard {
    return this.#clipboard
  }
  get mediaDevices(): MediaDevices {
    return this.#media
  }
  get permissions(): { query(): Promise<{ state: string; onchange: null }> } {
    return { query: () => Promise.resolve({ state: 'denied', onchange: null }) }
  }
  get storage(): { estimate(): Promise<{ quota: number; usage: number }>; persist(): Promise<boolean>; persisted(): Promise<boolean> } {
    return { estimate: () => Promise.resolve({ quota: 0, usage: 0 }), persist: () => Promise.resolve(false), persisted: () => Promise.resolve(false) }
  }
  get userActivation(): { hasBeenActive: boolean; isActive: boolean } {
    return { hasBeenActive: true, isActive: false }
  }
  get mimeTypes(): { length: number } {
    return { length: 0 }
  }
  get plugins(): { length: number } {
    return { length: 0 }
  }
  javaEnabled(): boolean {
    return false
  }
  sendBeacon(): boolean {
    return false
  }
  vibrate(): boolean {
    return false
  }
  share(): Promise<never> {
    return Promise.reject(new DOMException('Share is not supported', 'NotAllowedError'))
  }
  canShare(): boolean {
    return false
  }
  getGamepads(): unknown[] {
    return []
  }
}
tag(Navigator)

export class ScreenOrientation extends EventTarget {
  get type(): string {
    return viewport.width >= viewport.height ? 'landscape-primary' : 'portrait-primary'
  }
  get angle(): number {
    return 0
  }
  lock(): Promise<never> {
    return Promise.reject(new DOMException('Orientation lock is not supported', 'NotSupportedError'))
  }
  unlock(): void {}
}
tag(ScreenOrientation)

export class Screen extends EventTarget {
  readonly orientation = new ScreenOrientation()
  get width(): number {
    return viewport.width
  }
  get height(): number {
    return viewport.height
  }
  get availWidth(): number {
    return viewport.width
  }
  get availHeight(): number {
    return viewport.height
  }
  get availLeft(): number {
    return 0
  }
  get availTop(): number {
    return 0
  }
  get colorDepth(): number {
    return 24
  }
  get pixelDepth(): number {
    return 24
  }
  get isExtended(): boolean {
    return false
  }
}
tag(Screen)

export class VisualViewport extends EventTarget {
  get width(): number {
    return viewport.width
  }
  get height(): number {
    return viewport.height
  }
  get offsetLeft(): number {
    return 0
  }
  get offsetTop(): number {
    return 0
  }
  get pageLeft(): number {
    return scrollOf(0)
  }
  get pageTop(): number {
    return scrollOf(1)
  }
  get scale(): number {
    return 1
  }
}
defineHandlers(VisualViewport.prototype, ['resize', 'scroll', 'scrollend'])
tag(VisualViewport)

function scrollOf(axis: 0 | 1): number {
  const root = rootElement()
  const m = root ? metricsOf(root[ID]) : null
  return m ? (axis === 0 ? m.scrollLeft : m.scrollTop) : 0
}

function scrollViewport(x: number | null, y: number | null, smooth: boolean): void {
  const root = rootElement()
  if (root) scrollElement(root, x, y, smooth)
}

interface ScrollOptions {
  left?: number
  top?: number
  behavior?: string
}

function scrollWindow(x?: number | ScrollOptions, y?: number): void {
  if (typeof x === 'object' && x) scrollViewport(x.left ?? null, x.top ?? null, x.behavior === 'smooth')
  else scrollViewport(Number(x ?? 0), Number(y ?? 0), false)
}

interface WindowParts {
  readonly document: object
  readonly location: Location
  readonly history: History
  readonly navigator: Navigator
  readonly screen: Screen
  readonly visualViewport: VisualViewport
  readonly localStorage: Storage
  readonly sessionStorage: Storage
  readonly customElements: object
  readonly getSelection: () => unknown
}

export function installWindow(global: typeof globalThis, parts: WindowParts): void {
  Object.setPrototypeOf(global, Window.prototype)
  const self = () => global
  const getters: Record<string, () => unknown> = {
    window: self,
    self,
    frames: self,
    parent: self,
    top: self,
    document: () => parts.document,
    location: () => parts.location,
    history: () => parts.history,
    navigator: () => parts.navigator,
    clientInformation: () => parts.navigator,
    screen: () => parts.screen,
    visualViewport: () => parts.visualViewport,
    localStorage: () => parts.localStorage,
    sessionStorage: () => parts.sessionStorage,
    customElements: () => parts.customElements,
    event: () => windowEvent(),
    opener: () => null,
    frameElement: () => null,
    closed: () => false,
    length: () => 0,
    origin: () => here().origin,
    isSecureContext: () => true,
    crossOriginIsolated: () => false,
    devicePixelRatio: () => viewport.scale,
    innerWidth: () => viewport.width,
    innerHeight: () => viewport.height,
    outerWidth: () => viewport.width,
    outerHeight: () => viewport.height,
    screenX: () => 0,
    screenY: () => 0,
    screenLeft: () => 0,
    screenTop: () => 0,
    scrollX: () => scrollOf(0),
    scrollY: () => scrollOf(1),
    pageXOffset: () => scrollOf(0),
    pageYOffset: () => scrollOf(1),
  }
  for (const [name, get] of Object.entries(getters)) {
    Object.defineProperty(global, name, { get, set: name === 'location' ? (v: string) => parts.location.assign(v) : undefined, enumerable: true, configurable: true })
  }
  let name = ''
  Object.defineProperty(global, 'name', { get: () => name, set: (v: string) => void (name = String(v)), enumerable: true, configurable: true })
  let status = ''
  Object.defineProperty(global, 'status', { get: () => status, set: (v: string) => void (status = String(v)), enumerable: true, configurable: true })
  const bar = { visible: true }
  for (const key of ['menubar', 'toolbar', 'statusbar', 'locationbar', 'personalbar', 'scrollbars']) Object.defineProperty(global, key, { value: bar, enumerable: true, configurable: true })
  globals(global, {
    getComputedStyle: (element: Element, pseudo?: string | null): CSSStyleDeclaration => {
      if (!element || (element as unknown as { nodeType?: number }).nodeType !== NodeType.Element) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.")
      const p = pseudo ? String(pseudo) : ''
      return computedStyle(element, p === '::before' || p === ':before' ? '::before' : p === '::after' || p === ':after' ? '::after' : '')
    },
    matchMedia: (query: string) => new MediaQueryList(String(query)),
    requestAnimationFrame,
    cancelAnimationFrame,
    getSelection: parts.getSelection,
    Notification,
    showOpenFilePicker,
    showSaveFilePicker,
    FileSystemHandle,
    FileSystemFileHandle,
    FileSystemWritableFileStream,
    scroll: scrollWindow,
    scrollTo: scrollWindow,
    scrollBy: (x?: number | ScrollOptions, y?: number) => {
      const dx = typeof x === 'object' && x ? (x.left ?? 0) : Number(x ?? 0)
      const dy = typeof x === 'object' && x ? (x.top ?? 0) : Number(y ?? 0)
      scrollViewport(scrollOf(0) + dx, scrollOf(1) + dy, typeof x === 'object' && x?.behavior === 'smooth')
    },
    postMessage: (message: unknown, _origin?: unknown) => {
      const data = structuredClone(message)
      host.setTimer(0, () => {
        const MessageEvent = G['MessageEvent'] as new (type: string, init: object) => Event
        fire(global as unknown as EventTarget, new MessageEvent('message', { data, origin: here().origin, source: global }))
      })
    },
    alert: (message?: unknown) => (env.alert ? env.alert(String(message ?? '')) : host.print(0, `alert: ${String(message ?? '')}`)),
    confirm: (message?: unknown) => {
      host.print(0, `confirm: ${String(message ?? '')} (answered no)`)
      return false
    },
    prompt: (message?: unknown) => {
      host.print(0, `prompt: ${String(message ?? '')} (answered nothing)`)
      return null
    },
    print: () => {},
    stop: () => {},
    focus: () => {},
    blur: () => {},
    moveTo: () => {},
    moveBy: () => {},
    resizeTo: () => {},
    resizeBy: () => {},
    open: (url?: string, target?: string) => {
      if (!url) return null
      const href = new URL(String(url), env.url).href
      if (saves(href)) saveUrl(href, '')
      else env.navigate(href, target ? String(target) : '_blank')
      return null
    },
    close: () => env.close(),
    captureEvents: () => {},
    releaseEvents: () => {},
    createImageBitmap: () => Promise.reject(new DOMException('createImageBitmap is not supported', 'NotSupportedError')),
  })
  defineHandlers(global, [...HANDLER_TYPES, ...WINDOW_HANDLERS])
  linkHooks.follow = followLink
  entries.push({ url: env.url, state: null })
  index = 0
}
