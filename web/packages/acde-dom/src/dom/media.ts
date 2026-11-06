import { DOMException } from '../core/exception'
import { Event, fire } from '../core/event'
import { host, tag } from '../core/host'
import { Blob } from '../core/blob'
import { unbase64 } from '../core/encoding'
import { fetch } from '../core/net'
import { audioNative, mediaEvents } from '../audio/index'
import { contexts as gpuContexts, type GPUCanvasContext } from '../gpu/index'
import { canvases, type CanvasContext2d, type CanvasElement } from './canvas'
import { ATTRIBUTE_CHANGED, flags, handlerOf, setAttribute, tokenList, type DOMTokenList, type Element } from './element'
import { frames, resolveUrl } from './env'
import { HTMLElement, registerHtml } from './html'
import { metricsOf } from './layout'
import { bool, long, nullable, string, url } from './reflect'
import { dom, existing, ID, wrap } from './realm'

export const loading = new Set<number>()

const enum ImageState {
  Loading = 0,
  Loaded = 1,
  Failed = 2,
  NoSource = 3,
}

export class HTMLImageElement extends HTMLElement {
  #state(): Float64Array {
    return dom.imageState(this[ID])
  }

  get naturalWidth(): number {
    return this.#state()[0] ?? 0
  }

  get naturalHeight(): number {
    return this.#state()[1] ?? 0
  }

  get complete(): boolean {
    if (!dom.getAttribute(this[ID], 'src') && !dom.getAttribute(this[ID], 'srcset')) return true
    return this.#state()[2] !== ImageState.Loading
  }

  get currentSrc(): string {
    const src = dom.getAttribute(this[ID], 'src')
    return src ? resolveUrl(src) : ''
  }

  get width(): number {
    const m = metricsOf(this[ID])
    if (m) return m.offsetWidth
    const attr = parseInt(dom.getAttribute(this[ID], 'width') ?? '', 10)
    return Number.isNaN(attr) ? this.naturalWidth : attr
  }
  set width(value: number) {
    setAttribute(this, 'width', String(Math.trunc(Number(value)) || 0))
  }

  get height(): number {
    const m = metricsOf(this[ID])
    if (m) return m.offsetHeight
    const attr = parseInt(dom.getAttribute(this[ID], 'height') ?? '', 10)
    return Number.isNaN(attr) ? this.naturalHeight : attr
  }
  set height(value: number) {
    setAttribute(this, 'height', String(Math.trunc(Number(value)) || 0))
  }

  get x(): number {
    return metricsOf(this[ID])?.offsetLeft ?? 0
  }
  get y(): number {
    return metricsOf(this[ID])?.offsetTop ?? 0
  }

  decode(): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        const state = this.#state()[2]
        if (state === ImageState.Loaded) resolve()
        else reject(new DOMException('The source image cannot be decoded.', 'EncodingError'))
      }
      if (this.complete && dom.getAttribute(this[ID], 'src')) return settle()
      if (!dom.getAttribute(this[ID], 'src')) return reject(new DOMException('The source image cannot be decoded.', 'EncodingError'))
      const done = () => {
        this.removeEventListener('load', done)
        this.removeEventListener('error', done)
        settle()
      }
      this.addEventListener('load', done)
      this.addEventListener('error', done)
    })
  }

  override [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    super[ATTRIBUTE_CHANGED](name, value)
    if ((name === 'src' || name === 'srcset') && value) {
      loading.add(this[ID])
      frames.request()
    }
  }
}
url(HTMLImageElement.prototype, 'src')
for (const name of ['alt', 'srcset', 'sizes', 'useMap', 'decoding', 'loading', 'fetchPriority', 'name', 'align', 'border', 'longDesc', 'lowsrc']) string(HTMLImageElement.prototype, name, name.toLowerCase())
nullable(HTMLImageElement.prototype, 'crossOrigin', 'crossorigin')
string(HTMLImageElement.prototype, 'referrerPolicy', 'referrerpolicy')
bool(HTMLImageElement.prototype, 'isMap', 'ismap')
long(HTMLImageElement.prototype, 'hspace', 0)
long(HTMLImageElement.prototype, 'vspace', 0)
tag(HTMLImageElement)

export function deliverLoads(): boolean {
  const done = dom.takeLoaded()
  for (let i = 0; i < done.length; i++) {
    const id = done[i]!
    loading.delete(id)
    const state = dom.imageState(id)[2]
    if (state === ImageState.Loading) {
      loading.add(id)
      continue
    }
    if (state === ImageState.NoSource) continue
    let target = existing(id) as Element | undefined
    if (!target && flags.inlineHandlers && (dom.hasAttribute(id, 'onload') || dom.hasAttribute(id, 'onerror'))) target = wrap<Element>(id)!
    if (!target) continue
    if (flags.inlineHandlers) {
      handlerOf(target, 'load')
      handlerOf(target, 'error')
    }
    fire(target, new Event(state === ImageState.Loaded ? 'load' : 'error'))
  }
  return loading.size > 0
}

export class HTMLCanvasElement extends HTMLElement {
  get width(): number {
    const n = parseInt(dom.getAttribute(this[ID], 'width') ?? '', 10)
    return Number.isNaN(n) || n < 0 ? 300 : n
  }
  set width(value: number) {
    setAttribute(this, 'width', String(Math.max(0, Math.trunc(Number(value)) || 0)))
  }

  get height(): number {
    const n = parseInt(dom.getAttribute(this[ID], 'height') ?? '', 10)
    return Number.isNaN(n) || n < 0 ? 150 : n
  }
  set height(value: number) {
    setAttribute(this, 'height', String(Math.max(0, Math.trunc(Number(value)) || 0)))
  }

  override [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    super[ATTRIBUTE_CHANGED](name, value)
    if (name === 'width' || name === 'height') canvases.resized(this as unknown as CanvasElement)
  }

  getContext(type: string, _options?: unknown): CanvasContext2d | GPUCanvasContext | null {
    const kind = String(type)
    if (kind === '2d') return gpuContexts.has(this) ? null : canvases.context(this as unknown as CanvasElement)
    if (kind === 'webgpu') return canvases.has(this as unknown as CanvasElement) ? null : gpuContexts.of(this, this[ID])
    return null
  }

  toDataURL(type = 'image/png', _quality?: number): string {
    return gpuContexts.dataURL(this) ?? canvases.toDataURL(this as unknown as CanvasElement, String(type))
  }

  toBlob(callback: (blob: Blob | null) => void, type = 'image/png', quality?: number): void {
    const png = gpuContexts.png(this)
    if (png) {
      png.then((bytes) => callback(new Blob([bytes], { type: 'image/png' })), () => callback(null))
      return
    }
    const url = this.toDataURL(type, quality)
    const comma = url.indexOf(',')
    const mime = /^data:([^;,]*)/.exec(url)?.[1] || 'image/png'
    const bytes = comma < 0 ? null : unbase64(url.slice(comma + 1))
    host.setTimer(0, () => callback(bytes ? new Blob([bytes], { type: mime }) : null))
  }

  transferControlToOffscreen(): never {
    throw new DOMException('OffscreenCanvas is not supported', 'NotSupportedError')
  }

  captureStream(): never {
    throw new DOMException('captureStream is not supported', 'NotSupportedError')
  }
}
tag(HTMLCanvasElement)

const SANDBOX = Symbol('sandbox')

export class HTMLIFrameElement extends HTMLElement {
  get contentWindow(): null {
    return null
  }
  get contentDocument(): null {
    return null
  }
  get sandbox(): DOMTokenList {
    return tokenList(this, SANDBOX, 'sandbox', ['allow-downloads', 'allow-forms', 'allow-modals', 'allow-orientation-lock', 'allow-pointer-lock', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-presentation', 'allow-same-origin', 'allow-scripts', 'allow-top-navigation', 'allow-top-navigation-by-user-activation'])
  }
  getSVGDocument(): null {
    return null
  }
}
string(HTMLIFrameElement.prototype, 'src')
for (const name of ['srcdoc', 'name', 'allow', 'width', 'height', 'loading', 'referrerPolicy', 'align', 'scrolling', 'frameBorder']) string(HTMLIFrameElement.prototype, name, name.toLowerCase())
bool(HTMLIFrameElement.prototype, 'allowFullscreen', 'allowfullscreen')
tag(HTMLIFrameElement)

export class MediaError {
  static readonly MEDIA_ERR_ABORTED = 1
  static readonly MEDIA_ERR_NETWORK = 2
  static readonly MEDIA_ERR_DECODE = 3
  static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4
  readonly MEDIA_ERR_ABORTED = 1
  readonly MEDIA_ERR_NETWORK = 2
  readonly MEDIA_ERR_DECODE = 3
  readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4
  constructor(readonly code: number, readonly message: string) {}
}
tag(MediaError)

const playingMedia = new Map<number, HTMLMediaElement>()
const closedMedia = new FinalizationRegistry<number>((id) => audioNative()?.closeMedia(id))
const PLAYABLE = /^audio\/(wav|wave|x-wav|vnd\.wave|mpeg|mp3|x-mp3|mpeg3|ogg|vorbis|x-vorbis|flac|x-flac|aac|aacp|x-aac|mp4|m4a|x-m4a)$/i
let nextMedia = 1 << 24
const PLAYS = Symbol('plays')
const ENDED = Symbol('ended')

const timeRanges = (end: number) => ({ length: end > 0 ? 1 : 0, start: () => 0, end: () => end })

export class HTMLMediaElement extends HTMLElement {
  static readonly NETWORK_EMPTY = 0
  static readonly NETWORK_IDLE = 1
  static readonly NETWORK_LOADING = 2
  static readonly NETWORK_NO_SOURCE = 3
  static readonly HAVE_NOTHING = 0
  static readonly HAVE_METADATA = 1
  static readonly HAVE_CURRENT_DATA = 2
  static readonly HAVE_FUTURE_DATA = 3
  static readonly HAVE_ENOUGH_DATA = 4
  declare loop: boolean
  declare autoplay: boolean
  defaultPlaybackRate = 1
  preservesPitch = true
  #media = 0
  #generation = 0
  #loading = false
  #ready = 0
  #network = 0
  #error: MediaError | null = null
  #paused = true
  #ended = false
  #duration = NaN
  #position = 0
  #volume = 1
  #muted: boolean | null = null
  #rate = 1
  #pending: { resolve: () => void; reject: (e: unknown) => void }[] = []
  #timer = 0

  #emit(type: string): void {
    host.setTimer(0, () => {
      if (flags.inlineHandlers) handlerOf(this as unknown as Element, type)
      fire(this, new Event(type))
    })
  }

  [PLAYS](): boolean {
    return true
  }

  #source(): string {
    const src = dom.getAttribute(this[ID], 'src')
    if (src) return resolveUrl(src)
    const url = this.querySelector('source[src]')?.getAttribute('src')
    return url ? resolveUrl(url) : ''
  }

  #settle(error: unknown | null): void {
    const pending = this.#pending
    this.#pending = []
    for (const p of pending) error ? p.reject(error) : p.resolve()
  }

  #gain(): number {
    return this.muted ? 0 : this.#volume
  }

  #load(): void {
    const native = audioNative()
    const generation = ++this.#generation
    if (this.#media) {
      native?.closeMedia(this.#media)
      closedMedia.unregister(this)
      playingMedia.delete(this.#media)
      this.#media = 0
    }
    if (this.#network !== 0) this.#emit('emptied')
    this.#ready = 0
    this.#ended = false
    this.#duration = NaN
    this.#position = 0
    this.#error = null
    this.#stopTimer()
    const url = this.#source()
    if (!url || !this[PLAYS]()) {
      this.#network = url ? 3 : 0
      this.#loading = false
      return
    }
    this.#network = 2
    this.#loading = true
    this.#emit('loadstart')
    const fail = (code: number, message: string) => {
      if (generation !== this.#generation) return
      this.#loading = false
      this.#network = 3
      this.#error = new MediaError(code, message)
      this.#emit('error')
      this.#settle(new DOMException(`The element has no supported sources: ${message}`, 'NotSupportedError'))
    }
    if (!native) return fail(4, 'Media playback is not supported')
    const media = nextMedia++
    fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(
        (bytes) =>
          native.openMedia(media, new Uint8Array(bytes)).then(
            (info) => {
              if (generation !== this.#generation) return native.closeMedia(media)
              this.#media = media
              closedMedia.register(this, media, this)
              this.#loading = false
              this.#network = 1
              this.#ready = 4
              this.#duration = info.duration
              native.media(media, 3, this.#gain())
              if (this.loop) native.media(media, 4, 1)
              if (this.#rate !== 1) native.media(media, 5, this.#rate)
              if (this.#position > 0) native.media(media, 2, this.#position)
              for (const type of ['durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough']) this.#emit(type)
              if (!this.#paused) this.#start()
              else if (this.autoplay) void this.play().catch(() => {})
            },
            (error: unknown) => fail(4, String((error as Error)?.message ?? error)),
          ),
        (error: unknown) => fail(2, String((error as Error)?.message ?? error)),
      )
  }

  #start(): void {
    const native = audioNative()
    if (!native || !this.#media) return
    native.media(this.#media, 0, 0)
    playingMedia.set(this.#media, this)
    this.#emit('playing')
    this.#settle(null)
    this.#stopTimer()
    const tick = () => {
      this.#timer = host.setTimer(250, tick)
      this.#emit('timeupdate')
    }
    this.#timer = host.setTimer(250, tick)
  }

  #stopTimer(): void {
    if (this.#timer) host.clearTimer(this.#timer)
    this.#timer = 0
  }

  [ENDED](): void {
    playingMedia.delete(this.#media)
    this.#stopTimer()
    this.#ended = true
    this.#emit('timeupdate')
    if (!this.#paused) {
      this.#paused = true
      this.#emit('pause')
    }
    this.#emit('ended')
  }

  get paused(): boolean {
    return this.#paused
  }
  get ended(): boolean {
    return this.#ended && !this.loop
  }
  get duration(): number {
    return this.#duration
  }
  get readyState(): number {
    return this.#ready
  }
  get networkState(): number {
    return this.#network
  }
  get error(): MediaError | null {
    return this.#error
  }
  get currentSrc(): string {
    return this.#ready > 0 || this.#loading ? this.#source() : ''
  }
  get seeking(): boolean {
    return false
  }

  get currentTime(): number {
    const native = audioNative()
    return native && this.#media ? native.mediaTime(this.#media) : this.#position
  }
  set currentTime(value: number) {
    const t = Number(value)
    if (!Number.isFinite(t)) throw new TypeError("Failed to set the 'currentTime' property on 'HTMLMediaElement': The provided double value is non-finite.")
    this.#position = Math.max(0, t)
    this.#ended = false
    if (this.#media) {
      audioNative()?.media(this.#media, 2, this.#position)
      for (const type of ['seeking', 'timeupdate', 'seeked']) this.#emit(type)
    }
  }
  fastSeek(time: number): void {
    this.currentTime = time
  }

  get volume(): number {
    return this.#volume
  }
  set volume(value: number) {
    const v = Number(value)
    if (!Number.isFinite(v)) throw new TypeError("Failed to set the 'volume' property on 'HTMLMediaElement': The provided double value is non-finite.")
    if (v < 0 || v > 1) throw new DOMException(`Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${v}) is outside the range [0, 1].`, 'IndexSizeError')
    if (v === this.#volume) return
    this.#volume = v
    if (this.#media) audioNative()?.media(this.#media, 3, this.#gain())
    this.#emit('volumechange')
  }

  get muted(): boolean {
    return this.#muted ?? dom.hasAttribute(this[ID], 'muted')
  }
  set muted(value: boolean) {
    const muted = !!value
    if (muted === this.muted) {
      this.#muted = muted
      return
    }
    this.#muted = muted
    if (this.#media) audioNative()?.media(this.#media, 3, this.#gain())
    this.#emit('volumechange')
  }

  get playbackRate(): number {
    return this.#rate
  }
  set playbackRate(value: number) {
    const rate = Number(value)
    if (!Number.isFinite(rate)) throw new TypeError("Failed to set the 'playbackRate' property on 'HTMLMediaElement': The provided double value is non-finite.")
    this.#rate = rate
    if (this.#media) audioNative()?.media(this.#media, 5, rate)
    this.#emit('ratechange')
  }

  get buffered(): { length: number; start(): number; end(): number } {
    return timeRanges(this.#media && Number.isFinite(this.#duration) ? this.#duration : 0)
  }
  get seekable(): { length: number; start(): number; end(): number } {
    return this.buffered
  }
  get played(): { length: number; start(): number; end(): number } {
    return timeRanges(0)
  }
  get textTracks(): unknown[] {
    return []
  }

  play(): Promise<void> {
    if (!this[PLAYS]()) return Promise.reject(new DOMException('Video playback is not supported', 'NotSupportedError'))
    if (!audioNative()) return Promise.reject(new DOMException('Media playback is not supported', 'NotSupportedError'))
    if (this.#error?.code === 4 || this.#error?.code === 2) return Promise.reject(new DOMException(`The element has no supported sources: ${this.#error.message}`, 'NotSupportedError'))
    if (!this.#media && !this.#loading) {
      if (!this.#source()) return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
      this.#load()
    }
    if (this.ended) this.currentTime = 0
    const promise = new Promise<void>((resolve, reject) => this.#pending.push({ resolve, reject }))
    if (this.#paused) {
      this.#paused = false
      this.#emit('play')
      if (this.#media) this.#start()
    } else if (this.#media) {
      this.#settle(null)
    }
    return promise
  }

  pause(): void {
    if (this.#paused) return
    this.#paused = true
    if (this.#media) {
      audioNative()?.media(this.#media, 1, 0)
      playingMedia.delete(this.#media)
    }
    this.#stopTimer()
    this.#emit('timeupdate')
    this.#emit('pause')
    this.#settle(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
  }

  load(): void {
    if (!this.#paused) {
      this.#paused = true
      this.#emit('pause')
    }
    this.#settle(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'))
    this.#load()
  }

  canPlayType(type: string): string {
    if (!this[PLAYS]()) return ''
    const [mime = '', ...params] = String(type).split(';').map((s) => s.trim())
    if (!PLAYABLE.test(mime)) return ''
    const codecs = params.find((p) => /^codecs\s*=/i.test(p))
    if (codecs && /opus|webm|alac|ac-?3|ec-?3/i.test(codecs)) return ''
    return 'maybe'
  }

  addTextTrack(): never {
    throw new DOMException('Text tracks are not supported', 'NotSupportedError')
  }

  override [ATTRIBUTE_CHANGED](name: string, value: string | null): void {
    super[ATTRIBUTE_CHANGED](name, value)
    if (name === 'src') this.load()
    else if (name === 'loop' && this.#media) audioNative()?.media(this.#media, 4, value === null ? 0 : 1)
  }
}
url(HTMLMediaElement.prototype, 'src')
string(HTMLMediaElement.prototype, 'preload')
nullable(HTMLMediaElement.prototype, 'crossOrigin', 'crossorigin')
for (const name of ['autoplay', 'loop', 'controls']) bool(HTMLMediaElement.prototype, name)
bool(HTMLMediaElement.prototype, 'defaultMuted', 'muted')
tag(HTMLMediaElement)

mediaEvents.ended = (media) => playingMedia.get(media)?.[ENDED]()

export class HTMLVideoElement extends HTMLMediaElement {
  get videoWidth(): number {
    return 0
  }
  get videoHeight(): number {
    return 0
  }
  getVideoPlaybackQuality(): object {
    return { totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0, creationTime: 0 }
  }
  override [PLAYS](): boolean {
    return false
  }
}
for (const name of ['width', 'height']) long(HTMLVideoElement.prototype, name, 0)
url(HTMLVideoElement.prototype, 'poster')
bool(HTMLVideoElement.prototype, 'playsInline', 'playsinline')
tag(HTMLVideoElement)

export class HTMLAudioElement extends HTMLMediaElement {}
tag(HTMLAudioElement)

registerHtml(HTMLImageElement, 'img')
registerHtml(HTMLCanvasElement, 'canvas')
registerHtml(HTMLIFrameElement, 'iframe')
registerHtml(HTMLVideoElement, 'video')
registerHtml(HTMLAudioElement, 'audio')
