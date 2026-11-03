import { installCore, type CoreOptions } from './core/index'
import { inspectHooks } from './core/console'
import { CustomEvent, ErrorEvent, Event, fire, PromiseRejectionEvent, type EventTarget } from './core/event'
import { globals, host, report, setReport } from './core/host'
import { EventSource, fetch, Headers, net, Request, Response, WebSocket, XMLHttpRequest, XMLHttpRequestEventTarget, XMLHttpRequestUpload } from './core/net'
import { ReadableStream, ReadableStreamDefaultController, ReadableStreamDefaultReader, TextDecoderStream, TextEncoderStream, TransformStream, TransformStreamDefaultController, WritableStream, WritableStreamDefaultController, WritableStreamDefaultWriter } from './core/streams'
import { objectUrlOrigin, URL } from './core/url'
import type { AudioNative, DomNative, GpuNative, HostNative } from './native'
import { contexts as gpuContexts, installGpu } from './gpu/index'
import { installAudio } from './audio/index'
import { NodeType } from './native'
import { Animation, AnimationEffect, AnimationPlaybackEvent, AnimationTimeline, animate, animationsOf, DocumentTimeline, KeyframeEffect } from './dom/animation'
import { CanvasContext2d, CanvasGradient, CanvasPattern, canvases, ImageData, Path2D, TextMetrics } from './dom/canvas'
import { CustomElementRegistry } from './dom/custom'
import * as editing from './dom/editing'
import { Document, DOMImplementation, DOMParser, documentState, FontFace, FontFaceSet, HTMLDocument, XMLDocument, XMLSerializer } from './dom/document'
import { Attr, DOMStringMap, DOMTokenList, Element, flags, handlerOf, LOCAL, NamedNodeMap } from './dom/element'
import { env, frames } from './dom/env'
import * as events from './dom/events'
import { focus } from './dom/focus'
import * as forms from './dom/forms'
import { DOMMatrix, DOMMatrixReadOnly, DOMPoint, DOMPointReadOnly, DOMQuad, DOMRect, DOMRectList, DOMRectReadOnly } from './dom/geometry'
import * as html from './dom/html'
import { createHtml, HTMLElement } from './dom/html'
import { Input } from './dom/input'
import * as media from './dom/media'
import { deliverLoads } from './dom/media'
import { MutationObserver, MutationRecord } from './dom/mutation'
import { CDATASection, CharacterData, Comment, DocumentFragment, DocumentType, HTMLCollection, Node, NodeList, ProcessingInstruction, Text } from './dom/node'
import { deliverObservations, IntersectionObserver, IntersectionObserverEntry, ResizeObserver, ResizeObserverEntry, watching } from './dom/observers'
import { loadPage } from './dom/page'
import { AbstractRange, CaretPosition, getSelection, Range, Selection, StaticRange } from './dom/range'
import { bindDom, changed, documentId, dom, existing, idOf, moved, rootElementId, version, wrap, wrapperStats } from './dom/realm'
import { attachShadow, shadowRootOf, ShadowRoot } from './dom/shadow'
import { CSS, CSSRule, CSSRuleList, CSSStyleDeclaration, CSSStyleRule, CSSStyleSheet, StyleSheetList } from './dom/style'
import * as svg from './dom/svg'
import { NodeFilter, NodeIterator, TreeWalker } from './dom/traversal'
import { Clipboard, framesPending, History, installWindow, Location, MediaDevices, mediaChanged, MediaQueryList, Navigator, readViewport, runAnimationFrames, Screen, screenSize, ScreenOrientation, setNavigatorLanguages, Storage, storage, STORAGE_CHANGED, storageEntries, VisualViewport, Window, type NavigatorOptions } from './dom/window'

export type { AudioNative, DomNative, DomStats, GpuNative, HostNative, PhaseTiming } from './native'
export { installCore } from './core/index'
export { installBackendTransport, type BackendTransport, type Header as BackendHeader, type HttpEvent, type WsEvent } from './core/backend'

export interface InstallOptions extends CoreOptions, NavigatorOptions {
  readonly url: string
  readonly reducedMotion?: boolean
  readonly localStorage?: Readonly<Record<string, string>> | null
  readonly onStorageChange?: (entries: Record<string, string>) => void
  readonly logNetwork?: boolean
  readonly gpu?: GpuNative
  readonly audio?: AudioNative
  readonly screen?: { width: number; height: number }
}

export interface WebInternals {
  readonly window: typeof globalThis
  readonly document: Document
  readonly input: Input
  readonly env: typeof env
  readonly editing: typeof editing
  idOf(node: unknown): number
  nodeOf(id: number): unknown
  loadPage(html: string): Promise<void>
  frame(time: number): void
  endTask(): void
  resize(): void
  mediaChanged(): void
  setLanguages(languages: { language?: string; languages?: readonly string[] }): void
  setScreen(size: { width: number; height: number }): void
  setVisible(visible: boolean): void
  setActive(active: boolean): void
  reportError(error: unknown): void
  unhandledRejection(promise: Promise<unknown>, reason: unknown): boolean
  stats(): { strong: number; weak: number }
}

let installed: WebInternals | null = null

export function install(global: typeof globalThis, domNative: DomNative, hostNative: HostNative, options: InstallOptions): WebInternals {
  if (installed) throw new Error('acde-dom is installed in this context already')
  installCore(global, hostNative, options)
  bindDom(domNative)
  env.url = hostNative.parseUrl(options.url, null)?.href ?? options.url
  objectUrlOrigin.value = new URL(env.url).origin
  net.base = () => env.url
  net.log = options.logNetwork ?? true
  readViewport()
  if (options.screen) Object.assign(screenSize, options.screen)

  let reporting = false
  const reportError = (error: unknown) => {
    if (reporting) return host.reportError(error)
    reporting = true
    try {
      const message = error instanceof Error ? error.message : String(error)
      if (fire(global as unknown as EventTarget, new ErrorEvent('error', { message, error, cancelable: true }))) host.reportError(error)
    } finally {
      reporting = false
    }
  }
  setReport(reportError)

  const document = wrap<Document>(documentId)!
  const input = new Input()
  const local = storage(options.localStorage)
  const session = storage(null)
  let storageDirty = false
  local[STORAGE_CHANGED] = () => {
    storageDirty = true
  }
  const registry = new CustomElementRegistry()

  extendElements(input)
  const navigator = new Navigator(options)
  installWindow(global, {
    document,
    location: new Location(),
    history: new History(),
    navigator,
    screen: new Screen(),
    visualViewport: new VisualViewport(),
    localStorage: local,
    sessionStorage: session,
    customElements: registry,
    getSelection,
  })
  globals(global, interfaces())
  globals(global, legacyFactories())
  globals(global, { fetch })
  if (options.gpu) globals(global, installGpu(global, options.gpu, externalPixels))
  if (options.audio) globals(global, installAudio(options.audio))
  inspectHooks.node = (value) => {
    if (!(value instanceof Node)) return null
    if (value instanceof Element) {
      const id = value.id, cls = value.getAttribute('class')
      return `<${value[LOCAL]}${id ? `#${id}` : ''}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}>`
    }
    return value.nodeType === NodeType.Text ? `#text ${JSON.stringify((value as Text).data.slice(0, 40))}` : value.nodeName
  }

  let frameVersion = -1

  const deliverScrolls = () => {
    const scrolled = dom.takeScrolled()
    if (scrolled.length === 0) return
    moved()
    const root = rootElementId()
    for (const id of scrolled) {
      if (id === root || id === documentId) fire(document, new Event('scroll', { bubbles: true }))
      else {
        let target = existing(id) as Element | undefined
        if (!target && flags.inlineHandlers && dom.hasAttribute(id, 'onscroll')) target = wrap<Element>(id)!
        if (!target) continue
        if (flags.inlineHandlers) handlerOf(target, 'scroll')
        fire(target, new Event('scroll'))
      }
    }
  }

  installed = {
    window: global,
    document,
    input,
    env,
    editing,
    idOf,
    nodeOf: (id: number) => wrap(id),
    loadPage,
    frame(time) {
      frames.wanted = false
      moved()
      try {
        deliverScrolls()
        if (!gpuContexts.behind()) runAnimationFrames(time, report)
        deliverObservations()
      } catch (error) {
        report(error)
      }
      const loading = deliverLoads()
      canvases.flush()
      gpuContexts.present()
      frameVersion = version
      dom.commit()
      if (framesPending() || loading) frames.request()
    },
    endTask() {
      canvases.flush()
      gpuContexts.present()
      if (storageDirty) {
        storageDirty = false
        options.onStorageChange?.(storageEntries(local))
      }
      if (version !== frameVersion && watching()) frames.request()
      dom.commit()
    },
    resize() {
      readViewport()
      moved()
      changed()
      fire(global as unknown as EventTarget, new Event('resize'))
      fire((global as unknown as { visualViewport: EventTarget }).visualViewport, new Event('resize'))
      mediaChanged()
      if (watching()) frames.request()
    },
    mediaChanged,
    setLanguages(languages) {
      if (setNavigatorLanguages(navigator, languages)) fire(global as unknown as EventTarget, new Event('languagechange'))
    },
    setScreen(size) {
      Object.assign(screenSize, size)
    },
    setVisible(visible) {
      if (documentState.hidden === !visible) return
      documentState.hidden = !visible
      fire(document, new Event('visibilitychange', { bubbles: true }))
    },
    setActive(active) {
      if (focus.windowActive === active) return
      focus.windowActive = active
      fire(global as unknown as EventTarget, new events.FocusEvent(active ? 'focus' : 'blur'))
    },
    reportError,
    unhandledRejection(promise, reason) {
      const event = new PromiseRejectionEvent('unhandledrejection', { promise, reason, cancelable: true })
      const unhandled = fire(global as unknown as EventTarget, event)
      if (unhandled) host.reportError(reason)
      return unhandled
    },
    stats: wrapperStats,
  }
  return installed
}

function externalPixels(source: unknown): { width: number; height: number; rgba: Uint8Array } | null {
  if (source instanceof ImageData) return { width: source.width, height: source.height, rgba: new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength) }
  if (source instanceof media.HTMLCanvasElement) {
    const gpu = gpuContexts.byCanvas.get(source)
    if (gpu) return gpu.pixels()
    const { width, height } = source
    if (!width || !height || !canvases.has(source as never)) return null
    const rgba = canvases.pixels(source as never, 0, 0, width, height)
    return rgba && { width, height, rgba }
  }
  if (source instanceof media.HTMLImageElement) {
    const { naturalWidth: width, naturalHeight: height } = source as unknown as { naturalWidth: number; naturalHeight: number }
    if (!width || !height) return null
    const canvas = createHtml('canvas') as unknown as media.HTMLCanvasElement
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d') as CanvasContext2d
    context.drawImage(source as never, 0, 0)
    const rgba = canvases.pixels(canvas as never, 0, 0, width, height)
    return rgba && { width, height, rgba }
  }
  return null
}

function extendElements(input: Input): void {
  const proto = Element.prototype as unknown as Record<string, unknown>
  Object.defineProperties(proto, {
    animate: { value(this: Element, keyframes: unknown, options?: number | Record<string, unknown>) { return animate(this, keyframes, options) }, writable: true, configurable: true },
    getAnimations: { value(this: Element, options?: { subtree?: boolean }) { return animationsOf(this, !!options?.subtree) }, writable: true, configurable: true },
    attachShadow: { value(this: Element, init: { mode?: string; delegatesFocus?: boolean }) { return attachShadow(this, init) }, writable: true, configurable: true },
    shadowRoot: { get(this: Element) { return shadowRootOf(this) }, enumerable: true, configurable: true },
    setPointerCapture: { value(this: Element, pointerId: number) { input.setPointerCapture(this, pointerId) }, writable: true, configurable: true },
    releasePointerCapture: { value(this: Element, pointerId: number) { input.releasePointerCapture(this, pointerId) }, writable: true, configurable: true },
    hasPointerCapture: { value(this: Element) { return input.capture === this }, writable: true, configurable: true },
  })
}

function legacyFactories(): Record<string, unknown> {
  function Image(this: unknown, width?: number, height?: number) {
    if (!new.target) throw new TypeError("Failed to construct 'Image': Please use the 'new' operator.")
    const img = createHtml('img')
    if (width !== undefined) img.setAttribute('width', String(width))
    if (height !== undefined) img.setAttribute('height', String(height))
    return img
  }
  Image.prototype = media.HTMLImageElement.prototype
  function Option(this: unknown, text?: string, value?: string, defaultSelected?: boolean, selected?: boolean) {
    if (!new.target) throw new TypeError("Failed to construct 'Option': Please use the 'new' operator.")
    const option = createHtml('option') as unknown as forms.HTMLOptionElement
    if (text !== undefined) option.textContent = String(text)
    if (value !== undefined) option.setAttribute('value', String(value))
    if (defaultSelected) option.setAttribute('selected', '')
    if (selected) option.selected = true
    return option
  }
  Option.prototype = forms.HTMLOptionElement.prototype
  function Audio(this: unknown, src?: string) {
    if (!new.target) throw new TypeError("Failed to construct 'Audio': Please use the 'new' operator.")
    const audio = createHtml('audio')
    audio.setAttribute('preload', 'auto')
    if (src !== undefined) audio.setAttribute('src', String(src))
    return audio
  }
  Audio.prototype = media.HTMLAudioElement.prototype
  return { Image, Option, Audio }
}

function interfaces(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Window, Node, CharacterData, Text, CDATASection, Comment, ProcessingInstruction, DocumentType, DocumentFragment, ShadowRoot,
    Document, HTMLDocument, XMLDocument, Element, HTMLElement, Attr, NamedNodeMap, NodeList, HTMLCollection, DOMTokenList, DOMStringMap,
    CSSStyleDeclaration, CSSStyleSheet, CSSRule, CSSRuleList, CSSStyleRule, StyleSheetList, CSS,
    MutationObserver, MutationRecord, ResizeObserver, ResizeObserverEntry, IntersectionObserver, IntersectionObserverEntry,
    AbstractRange, Range, StaticRange, Selection, CaretPosition, TreeWalker, NodeIterator, NodeFilter,
    DOMParser, XMLSerializer, DOMImplementation, FontFace, FontFaceSet,
    DOMRect, DOMRectReadOnly, DOMRectList, DOMPoint, DOMPointReadOnly, DOMMatrix, DOMMatrixReadOnly, DOMQuad, SVGMatrix: DOMMatrix, SVGPoint: DOMPoint, SVGRect: DOMRect,
    CanvasRenderingContext2D: CanvasContext2d, CanvasGradient, CanvasPattern, Path2D, ImageData, TextMetrics,
    Animation, AnimationEffect, KeyframeEffect, AnimationTimeline, DocumentTimeline, AnimationPlaybackEvent,
    CustomElementRegistry, Location, History, Navigator, Screen, ScreenOrientation, VisualViewport, Storage, MediaQueryList, Clipboard, MediaDevices,
    Headers, Request, Response, XMLHttpRequest, XMLHttpRequestEventTarget, XMLHttpRequestUpload, WebSocket, EventSource,
    ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController, WritableStream, WritableStreamDefaultWriter,
    WritableStreamDefaultController, TransformStream, TransformStreamDefaultController, TextDecoderStream, TextEncoderStream,
    CustomEvent, ErrorEvent,
  }
  for (const module of [events, forms, html, media, svg] as Record<string, unknown>[]) {
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === 'function' && /^[A-Z]/.test(name) && value.prototype) out[name] = value
    }
  }
  delete out['HTMLOrSVGElementMixin']
  return out
}
