export const NONE = -1

export const enum NodeType {
  Element = 1,
  Text = 3,
  Comment = 8,
  Document = 9,
  DocumentType = 10,
  DocumentFragment = 11,
}

export const enum Ns {
  Html = 0,
  Svg = 1,
  MathMl = 2,
}

export interface Metrics {
  offsetLeft: number
  offsetTop: number
  offsetWidth: number
  offsetHeight: number
  offsetParent: number
  clientLeft: number
  clientTop: number
  clientWidth: number
  clientHeight: number
  scrollLeft: number
  scrollTop: number
  scrollWidth: number
  scrollHeight: number
}

export interface DomNative {
  document(): number
  parseDocument(html: string): void
  viewport(): { width: number; height: number; scale: number }

  nodeType(id: number): NodeType
  parent(id: number): number
  firstChild(id: number): number
  lastChild(id: number): number
  nextSibling(id: number): number
  previousSibling(id: number): number
  childNodes(id: number): Uint32Array
  children(id: number): Uint32Array
  childCount(id: number): number
  isConnected(id: number): boolean
  ancestors(id: number): Uint32Array
  describe(id: number): [NodeType, Ns, boolean, string]
  resize?(width: number, height: number, scale: number): void
  setReducedMotion?(on: boolean): void
  setDark?(on: boolean): void
  compareDocumentPosition(a: number, b: number): number

  createElement(ns: Ns, localName: string): number
  createText(data: string): number
  createComment(data: string): number
  createFragment(): number
  createDocumentType(name: string, publicId: string, systemId: string): number
  documentType(id: number): string[]
  clone(id: number, deep: boolean): number

  insertBefore(parent: number, child: number, reference: number): void
  remove(child: number): void
  replaceChildren(parent: number, ids: Uint32Array): void

  localName(id: number): string
  namespace(id: number): Ns
  getAttribute(id: number, name: string): string | null
  setAttribute(id: number, name: string, value: string): boolean
  removeAttribute(id: number, name: string): boolean
  hasAttribute(id: number, name: string): boolean
  attributes(id: number): string[]
  id(id: number): string
  className(id: number): string

  data(id: number): string
  setData(id: number, data: string): void

  textContent(id: number): string
  setTextContent(id: number, text: string): void
  innerText(id: number): string
  innerHTML(id: number): string
  outerHTML(id: number): string
  parseFragment(context: number, html: string): number
  templateContent(id: number): number
  parseInert(html: string): number

  querySelector(root: number, selector: string): number
  querySelectorAll(root: number, selector: string): Uint32Array
  matches(id: number, selector: string): boolean
  closest(id: number, selector: string): number
  getElementById(id: string): number
  getElementsByClassName(root: number, classNames: string): Uint32Array
  getElementsByTagName(root: number, qualifiedName: string): Uint32Array

  value(id: number): string
  setValue(id: number, value: string): void
  checked(id: number): boolean
  setChecked(id: number, checked: boolean): void
  selectedIndex(id: number): number
  setSelectedIndex(id: number, index: number): void
  setSelectionRange(id: number, start: number, end: number): void

  setFocus(id: number, visible: boolean): void
  setActive(id: number): void
  setSelection(anchorNode: number, anchorOffset: number, focusNode: number, focusOffset: number): void

  rect(id: number): Float64Array
  clientRects(id: number): Float64Array
  metrics(id: number): Metrics | null
  hitTest(x: number, y: number): number
  hitTestAll(x: number, y: number): Uint32Array
  computedStyle(id: number, pseudo: string, property: string): string
  computedStyleAll(id: number, pseudo: string): string[]
  caretRect(id: number, offset: number): Float64Array
  caretFromPoint(x: number, y: number): { node: number; offset: number } | null
  textRects(id: number, start: number, end: number): Float64Array
  matchMedia(query: string): boolean
  parseColor(color: string): Float64Array | null

  sheetRuleCount(id: number): number
  sheetRule(id: number, index: number): string
  sheetInsertRule(id: number, rule: string, index: number): number
  sheetDeleteRule(id: number, index: number): void

  scrollTo(id: number, left: number, top: number, smooth: boolean): void
  takeScrolled(): Uint32Array

  imageState(id: number): Float64Array
  takeLoaded(): Uint32Array
  canvas(id: number, commands: Uint8Array): void
  measureText(id: number, font: string, text: string): Float64Array
  toDataURL(id: number, type: string): string
  getImageData(id: number, x: number, y: number, width: number, height: number): Uint8Array
  capture(id: number, scale: number): { x: number; y: number; width: number; height: number; pixelWidth: number; pixelHeight: number; scale: number; rgba: Uint8Array } | null

  setPanel(id: number, x: number, y: number, width: number, height: number): void
  unpin(id: number): void
  pinnedIn(root: number): Uint32Array

  commit(): void

  semantics?(root: number, limit: number): string

  stats(reset?: boolean): DomStats
}

export interface PhaseTiming {
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
}

export interface DomStats {
  readonly resolve: PhaseTiming
  readonly frame: PhaseTiming
  readonly frameLocked: PhaseTiming
  readonly resolveMs: number
  readonly paintMs: number
  readonly damageMs: number
  readonly layersMs: number
  readonly fragmentsRecorded: number
  readonly fragmentsReused: number
  readonly animating: boolean
  readonly nodes: number
  readonly images: number
  readonly imageBytes: number
  readonly mallocBytes: number
}

export interface HostNative {
  now(): number
  timeOrigin(): number
  setTimer(ms: number, callback: () => void, refed?: boolean): number
  clearTimer(handle: number): void
  refTimer(handle: number, refed: boolean): void
  queueMicrotask(callback: () => void): void
  requestFrame(): void
  reportError(error: unknown): void
  print(level: number, text: string): void
  log(level: number, target: string, text: string): void
  logEnabled(level: number, target: string): boolean
  clock(): number

  importModule(url: string): Promise<unknown>
  defineModule(url: string, exports: object): void
  runModule(source: string, url: string): Promise<unknown>
  runScript(source: string, url: string): unknown

  readAsset(url: string): Uint8Array | null
  addImportMap?(imports: [string, string][], scopes: [string, [string, string][]][]): void

  encodeUtf8(text: string): Uint8Array
  decode(bytes: Uint8Array, label: string, fatal: boolean, ignoreBom: boolean): string
  parseUrl(input: string, base: string | null): { href: string; origin: string; protocol: string; username: string; password: string; host: string; hostname: string; port: string; pathname: string; search: string; hash: string } | null
  serialize(value: unknown): Uint8Array
  deserialize(bytes: Uint8Array): unknown
  randomBytes(buffer: Uint8Array): void
  randomUUID(): string
}

export interface GpuNative {
  requestAdapter(): Promise<GpuAdapterInfo | null>
  createDevice(features: string[], limits: Record<string, number>, onError: (kind: string, message: string) => void, onLost: (reason: string, message: string) => void): number
  destroyDevice(device: number): void
  pushErrorScope(device: number, filter: string): void
  popErrorScope(device: number): GpuErrorInfo | null | undefined
  drop(id: number): void

  createBuffer(device: number, descriptor: string): number
  destroyBuffer(device: number, buffer: number): void
  mapAsync(device: number, buffer: number, mode: number, offset: number, size: number): Promise<string | null>
  getMappedRange(buffer: number, offset: number, size: number): ArrayBuffer
  unmap(device: number, buffer: number, written: (number | ArrayBuffer)[]): void
  createTexture(device: number, descriptor: string): number
  destroyTexture(device: number, texture: number): void
  createView(device: number, texture: number, descriptor: string): number
  createSampler(device: number, descriptor: string): number
  createBindGroupLayout(device: number, descriptor: string): number
  createPipelineLayout(device: number, descriptor: string): number
  createBindGroup(device: number, descriptor: string): number
  createShaderModule(device: number, code: string, label: string): number
  compilationInfo(module: number): GpuCompilationMessage[]
  createComputePipeline(device: number, descriptor: string, async: boolean): number | string
  createRenderPipeline(device: number, descriptor: string, async: boolean): number | string
  getBindGroupLayout(device: number, pipeline: number, index: number): number
  createQuerySet(device: number, descriptor: string): number
  destroyQuerySet(device: number, querySet: number): void

  createCommandEncoder(device: number, label: string): number
  copyBufferToBuffer(device: number, encoder: number, source: number, sourceOffset: number, destination: number, destinationOffset: number, size: number): void
  copyBufferToTexture(device: number, encoder: number, descriptor: string): void
  copyTextureToBuffer(device: number, encoder: number, descriptor: string): void
  copyTextureToTexture(device: number, encoder: number, descriptor: string): void
  clearBuffer(device: number, encoder: number, buffer: number, offset: number, size: number): void
  resolveQuerySet(device: number, encoder: number, querySet: number, first: number, count: number, destination: number, offset: number): void
  encoderDebug(device: number, encoder: number, op: number, label: string): void
  renderPass(device: number, encoder: number, descriptor: string, commands: Float64Array, length: number, strings: string[]): void
  computePass(device: number, encoder: number, descriptor: string, commands: Float64Array, length: number, strings: string[]): void
  finishEncoder(device: number, encoder: number, label: string): number
  createRenderBundle(device: number, descriptor: string, commands: Float64Array, length: number, strings: string[]): number

  submit(device: number, buffers: number[]): void
  writeBuffer(device: number, buffer: number, offset: number, data: ArrayBufferView | ArrayBuffer): void
  writeTexture(device: number, descriptor: string, data: ArrayBufferView | ArrayBuffer): void
  onSubmittedWorkDone(device: number): Promise<void>

  preferredFormat(): string
  configure(node: number, device: number, descriptor: string): void
  unconfigure(node: number): void
  currentTexture(node: number, width: number, height: number): number
  present(node: number): void
  pixels(node: number): { width: number; height: number; rgba: Uint8Array } | null
  png(node: number, width: number, height: number): Uint8Array
  pngAsync(node: number, width: number, height: number): Promise<Uint8Array>
}

export interface GpuAdapterInfo {
  vendor: string
  architecture: string
  device: string
  description: string
  features: string[]
  limits: Record<string, number>
}

export interface GpuErrorInfo {
  kind: string
  message: string
}

export interface GpuCompilationMessage {
  message: string
  type: 'error' | 'warning' | 'info'
  lineNum: number
  linePos: number
  offset: number
  length: number
}

export interface AudioNative {
  readonly sampleRate: number
  onEvent(callback: (kind: number, id: number) => void): void
  createContext(context: number, destination: number): void
  setRunning(context: number, running: boolean): void
  closeContext(context: number): void
  time(context: number): number
  createNode(context: number, node: number, kind: number): void
  connect(from: number, to: number, param: number): void
  disconnect(from: number, to: number, param: number): void
  automate(node: number, param: number, op: number, value: number, time: number, extra: number): void
  automateCurve(node: number, param: number, values: Float32Array, time: number, duration: number): void
  paramValue(node: number, param: number): number
  setWave(node: number, type: number): void
  setLoop(node: number, loop: boolean, loopStart: number, loopEnd: number): void
  setBuffer(node: number, buffer: number): void
  start(node: number, when: number, offset: number, duration: number): void
  stop(node: number, when: number): void
  release(node: number): void
  decode(buffer: number, bytes: Uint8Array): Promise<{ length: number; sampleRate: number; numberOfChannels: number }>
  createBuffer(buffer: number, sampleRate: number, channels: Float32Array[]): void
  channelData(buffer: number): Float32Array[]
  releaseBuffer(buffer: number): void
  openMedia(media: number, bytes: Uint8Array): Promise<{ duration: number; sampleRate: number; numberOfChannels: number }>
  media(media: number, op: number, value: number): void
  mediaTime(media: number): number
  closeMedia(media: number): void
}
