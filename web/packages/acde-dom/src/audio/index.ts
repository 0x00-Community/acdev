import { DOMException } from '../core/exception'
import { defineHandlers, Event, EventTarget, fire } from '../core/event'
import { host, tag } from '../core/host'
import type { AudioNative } from '../native'

let native: AudioNative | null = null
let nextId = 1
const newId = (): number => nextId++

export function audioNative(): AudioNative | null {
  return native
}

export const mediaEvents = { ended: (_media: number): void => {} }

const KEY = Symbol('key')
const ID = Symbol('id')
const UPLOAD = Symbol('upload')

const playing = new Map<number, AudioScheduledSourceNode>()
const live = new Set<BaseAudioContext>()
const releasedNodes = new FinalizationRegistry<number>((id) => native?.release(id))
const releasedBuffers = new FinalizationRegistry<number>((id) => native?.releaseBuffer(id))
const warned = new Set<string>()

function illegal(token: unknown): void {
  if (token !== KEY) throw new TypeError('Illegal constructor')
}

function finite(what: string, value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`Failed to execute '${what}': the value provided is non-finite.`)
  return n
}

function time(what: string, value: unknown): number {
  const t = finite(what, value)
  if (t < 0) throw new RangeError(`Failed to execute '${what}': the time must be non-negative.`)
  return t
}

function later(fn: () => void): void {
  host.setTimer(0, fn)
}

class AudioParam {
  readonly #owner: AudioNode
  readonly #node: number
  readonly #index: number
  readonly #default: number
  readonly #min: number
  readonly #max: number
  #value: number
  #automated = false

  constructor(token: unknown, owner: AudioNode, index: number, defaultValue: number, min: number, max: number) {
    illegal(token)
    this.#owner = owner
    this.#node = owner[ID]
    this.#index = index
    this.#default = defaultValue
    this.#min = min
    this.#max = max
    this.#value = defaultValue
  }

  get defaultValue(): number {
    return this.#default
  }
  get minValue(): number {
    return this.#min
  }
  get maxValue(): number {
    return this.#max
  }
  get automationRate(): string {
    return 'a-rate'
  }
  set automationRate(_value: string) {}

  get value(): number {
    if (this.#automated && native) return native.paramValue(this.#node, this.#index)
    return Math.min(this.#max, Math.max(this.#min, this.#value))
  }
  set value(value: number) {
    const v = finite('AudioParam.value', value)
    this.#value = v
    native?.automate(this.#node, this.#index, 0, v, 0, 0)
  }

  get [ID](): [number, number] {
    this.#automated = true
    return [this.#node, this.#index]
  }

  get [KEY](): AudioNode {
    return this.#owner
  }

  #automate(op: number, value: number, at: number, extra = 0): this {
    this.#automated = true
    native?.automate(this.#node, this.#index, op, value, at, extra)
    return this
  }

  setValueAtTime(value: number, startTime: number): this {
    return this.#automate(1, finite('setValueAtTime', value), time('setValueAtTime', startTime))
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    return this.#automate(2, finite('linearRampToValueAtTime', value), time('linearRampToValueAtTime', endTime))
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    const v = finite('exponentialRampToValueAtTime', value)
    if (v === 0) throw new RangeError("Failed to execute 'exponentialRampToValueAtTime': the float target value provided (0) should not be in the range (-1.40130e-45, 1.40130e-45).")
    return this.#automate(3, v, time('exponentialRampToValueAtTime', endTime))
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    const tc = finite('setTargetAtTime', timeConstant)
    if (tc < 0) throw new RangeError("Failed to execute 'setTargetAtTime': the time constant must be non-negative.")
    return this.#automate(4, finite('setTargetAtTime', target), time('setTargetAtTime', startTime), tc)
  }

  setValueCurveAtTime(values: ArrayLike<number>, startTime: number, duration: number): this {
    const curve = Float32Array.from(values as ArrayLike<number>)
    if (curve.length < 2) throw new DOMException("Failed to execute 'setValueCurveAtTime': the curve must have at least two values.", 'InvalidStateError')
    for (const v of curve) finite('setValueCurveAtTime', v)
    const at = time('setValueCurveAtTime', startTime)
    const d = finite('setValueCurveAtTime', duration)
    if (d <= 0) throw new RangeError("Failed to execute 'setValueCurveAtTime': the duration must be positive.")
    this.#automated = true
    native?.automateCurve(this.#node, this.#index, curve, at, d)
    return this
  }

  cancelScheduledValues(cancelTime: number): this {
    return this.#automate(5, 0, time('cancelScheduledValues', cancelTime))
  }

  cancelAndHoldAtTime(cancelTime: number): this {
    return this.#automate(6, 0, time('cancelAndHoldAtTime', cancelTime))
  }
}
tag(AudioParam)

const enum Kind {
  Gain = 1,
  Oscillator = 2,
  BufferSource = 3,
  StereoPanner = 4,
  ConstantSource = 5,
  Through = 6,
}

class AudioNode extends EventTarget {
  readonly [ID]: number
  readonly #context: BaseAudioContext
  readonly #inputs: number
  readonly #outputs: number
  channelCount = 2
  channelCountMode = 'max'
  channelInterpretation = 'speakers'

  constructor(token: unknown, context: BaseAudioContext, kind: number, inputs = 1, outputs = 1, id?: number) {
    illegal(token)
    super()
    this.#context = context
    this.#inputs = inputs
    this.#outputs = outputs
    this[ID] = id ?? newId()
    if (kind > 0) {
      native?.createNode(context[ID], this[ID], kind)
      releasedNodes.register(this, this[ID])
    }
  }

  get context(): BaseAudioContext {
    return this.#context
  }
  get numberOfInputs(): number {
    return this.#inputs
  }
  get numberOfOutputs(): number {
    return this.#outputs
  }

  connect<T extends AudioNode>(destination: T, output?: number, input?: number): T
  connect(destination: AudioParam, output?: number): undefined
  connect(destination: AudioNode | AudioParam, output = 0, _input = 0): AudioNode | undefined {
    if (Number(output) >= this.#outputs) throw new DOMException(`Failed to execute 'connect' on 'AudioNode': output index (${output}) exceeds number of outputs (${this.#outputs}).`, 'IndexSizeError')
    if (destination instanceof AudioParam) {
      if (destination[KEY].context !== this.#context) throw new DOMException("Failed to execute 'connect' on 'AudioNode': cannot connect to an AudioParam belonging to a different audio context.", 'InvalidAccessError')
      const [node, index] = destination[ID]
      native?.connect(this[ID], node, index)
      return undefined
    }
    if (!(destination instanceof AudioNode)) throw new TypeError("Failed to execute 'connect' on 'AudioNode': parameter 1 is not of type 'AudioNode'.")
    if (destination.context !== this.#context) throw new DOMException("Failed to execute 'connect' on 'AudioNode': cannot connect to an AudioNode belonging to a different audio context.", 'InvalidAccessError')
    if (destination.numberOfInputs === 0) throw new DOMException("Failed to execute 'connect' on 'AudioNode': the destination has no inputs.", 'IndexSizeError')
    native?.connect(this[ID], destination[ID], -1)
    return destination
  }

  disconnect(destination?: AudioNode | AudioParam | number, _output?: number, _input?: number): void {
    if (destination instanceof AudioParam) {
      const [node, index] = destination[ID]
      native?.disconnect(this[ID], node, index)
    } else if (destination instanceof AudioNode) {
      native?.disconnect(this[ID], destination[ID], -1)
    } else {
      native?.disconnect(this[ID], -1, -1)
    }
  }
}
tag(AudioNode)

class AudioDestinationNode extends AudioNode {
  get maxChannelCount(): number {
    return 2
  }
}
tag(AudioDestinationNode)

function param(node: AudioNode, index: number, defaultValue: number, min = -3.4028234663852886e38, max = 3.4028234663852886e38): AudioParam {
  return new AudioParam(KEY, node, index, defaultValue, min, max)
}

function initParams(options: Record<string, unknown> | undefined, params: Record<string, AudioParam>): void {
  if (!options) return
  for (const [name, p] of Object.entries(params)) {
    if (options[name] !== undefined) p.value = Number(options[name])
  }
}

class AudioScheduledSourceNode extends AudioNode {
  #started = false

  constructor(token: unknown, context: BaseAudioContext, kind: number) {
    super(token, context, kind, 0, 1)
  }

  start(when = 0, ..._rest: unknown[]): void {
    if (this.#started) throw new DOMException("Failed to execute 'start' on 'AudioScheduledSourceNode': cannot call start more than once.", 'InvalidStateError')
    const at = time('start', when)
    this.#started = true
    playing.set(this[ID], this)
    this.startAt(at)
  }

  protected startAt(when: number): void {
    native?.start(this[ID], when, 0, -1)
  }

  stop(when = 0): void {
    if (!this.#started) throw new DOMException("Failed to execute 'stop' on 'AudioScheduledSourceNode': cannot call stop without calling start first.", 'InvalidStateError')
    native?.stop(this[ID], time('stop', when))
  }

  ended(): void {
    fire(this, new Event('ended'))
  }
}
defineHandlers(AudioScheduledSourceNode.prototype, ['ended'])
tag(AudioScheduledSourceNode)

const WAVES = ['sine', 'square', 'sawtooth', 'triangle']

class OscillatorNode extends AudioScheduledSourceNode {
  readonly frequency: AudioParam
  readonly detune: AudioParam
  #type = 'sine'

  constructor(context: BaseAudioContext, options?: { type?: string; frequency?: number; detune?: number; periodicWave?: PeriodicWave }) {
    checkContext(context)
    super(KEY, context, Kind.Oscillator)
    const nyquist = context.sampleRate / 2
    this.frequency = param(this, 0, 440, -nyquist, nyquist)
    this.detune = param(this, 1, 0, -153600, 153600)
    initParams(options as Record<string, unknown>, { frequency: this.frequency, detune: this.detune })
    if (options?.periodicWave) this.setPeriodicWave(options.periodicWave)
    else if (options?.type !== undefined) this.type = options.type
  }

  get type(): string {
    return this.#type
  }
  set type(value: string) {
    const type = String(value)
    if (type === 'custom') throw new DOMException("Failed to set the 'type' property on 'OscillatorNode': 'type' cannot be set directly to 'custom'. Use setPeriodicWave() to create a custom Oscillator type.", 'InvalidStateError')
    const code = WAVES.indexOf(type)
    if (code < 0) return
    this.#type = type
    native?.setWave(this[ID], code)
  }

  setPeriodicWave(wave: PeriodicWave): void {
    if (!(wave instanceof PeriodicWave)) throw new TypeError("Failed to execute 'setPeriodicWave' on 'OscillatorNode': parameter 1 is not of type 'PeriodicWave'.")
    warnOnce('PeriodicWave', 'custom oscillator waves are not rendered yet: a sine plays instead')
    this.#type = 'custom'
    native?.setWave(this[ID], 0)
  }
}
tag(OscillatorNode)

class PeriodicWave {
  constructor(context: BaseAudioContext, _options?: { real?: ArrayLike<number>; imag?: ArrayLike<number>; disableNormalization?: boolean }) {
    checkContext(context)
  }
}
tag(PeriodicWave)

class GainNode extends AudioNode {
  readonly gain: AudioParam

  constructor(context: BaseAudioContext, options?: { gain?: number }) {
    checkContext(context)
    super(KEY, context, Kind.Gain)
    this.gain = param(this, 0, 1)
    initParams(options as Record<string, unknown>, { gain: this.gain })
  }
}
tag(GainNode)

class StereoPannerNode extends AudioNode {
  readonly pan: AudioParam

  constructor(context: BaseAudioContext, options?: { pan?: number }) {
    checkContext(context)
    super(KEY, context, Kind.StereoPanner)
    this.pan = param(this, 0, 0, -1, 1)
    initParams(options as Record<string, unknown>, { pan: this.pan })
  }
}
tag(StereoPannerNode)

class ConstantSourceNode extends AudioScheduledSourceNode {
  readonly offset: AudioParam

  constructor(context: BaseAudioContext, options?: { offset?: number }) {
    checkContext(context)
    super(KEY, context, Kind.ConstantSource)
    this.offset = param(this, 0, 1)
    initParams(options as Record<string, unknown>, { offset: this.offset })
  }
}
tag(ConstantSourceNode)

export class AudioBufferSourceNode extends AudioScheduledSourceNode {
  readonly playbackRate: AudioParam
  readonly detune: AudioParam
  #buffer: AudioBuffer | null = null
  #loop = false
  #loopStart = 0
  #loopEnd = 0
  #started = false

  constructor(context: BaseAudioContext, options?: { buffer?: AudioBuffer | null; playbackRate?: number; detune?: number; loop?: boolean; loopStart?: number; loopEnd?: number }) {
    checkContext(context)
    super(KEY, context, Kind.BufferSource)
    this.playbackRate = param(this, 0, 1)
    this.detune = param(this, 1, 0)
    initParams(options as Record<string, unknown>, { playbackRate: this.playbackRate, detune: this.detune })
    if (options?.buffer) this.buffer = options.buffer
    if (options?.loop !== undefined) this.loop = !!options.loop
    if (options?.loopStart !== undefined) this.loopStart = Number(options.loopStart)
    if (options?.loopEnd !== undefined) this.loopEnd = Number(options.loopEnd)
  }

  get buffer(): AudioBuffer | null {
    return this.#buffer
  }
  set buffer(value: AudioBuffer | null) {
    if (value !== null && !(value instanceof AudioBuffer)) throw new TypeError("Failed to set the 'buffer' property on 'AudioBufferSourceNode': The provided value is not of type 'AudioBuffer'.")
    this.#buffer = value
    if (this.#started) native?.setBuffer(this[ID], value ? value[UPLOAD]() : 0)
  }

  get loop(): boolean {
    return this.#loop
  }
  set loop(value: boolean) {
    this.#loop = !!value
    this.#sendLoop()
  }
  get loopStart(): number {
    return this.#loopStart
  }
  set loopStart(value: number) {
    this.#loopStart = finite('loopStart', value)
    this.#sendLoop()
  }
  get loopEnd(): number {
    return this.#loopEnd
  }
  set loopEnd(value: number) {
    this.#loopEnd = finite('loopEnd', value)
    this.#sendLoop()
  }

  #sendLoop(): void {
    native?.setLoop(this[ID], this.#loop, this.#loopStart, this.#loopEnd)
  }

  override start(when = 0, offset = 0, duration?: number): void {
    const o = time('start', offset)
    const d = duration === undefined ? -1 : time('start', duration)
    this.#offset = o
    this.#duration = d
    super.start(when)
  }

  #offset = 0
  #duration = -1

  protected override startAt(when: number): void {
    this.#started = true
    if (this.#buffer) native?.setBuffer(this[ID], this.#buffer[UPLOAD]())
    native?.start(this[ID], when, this.#offset, this.#duration)
  }
}
tag(AudioBufferSourceNode)

function warnOnce(what: string, message: string): void {
  if (warned.has(what)) return
  warned.add(what)
  host.print(1, `acde-dom: ${message}`)
}

type PassThrough = new (context: BaseAudioContext, options?: Record<string, unknown>) => AudioNode

function passThrough(name: string, params: [string, number, number?, number?][], extra?: (node: AudioNode) => void): PassThrough {
  const cls = class extends AudioNode {
    constructor(context: BaseAudioContext, options?: Record<string, unknown>) {
      checkContext(context)
      super(KEY, context, Kind.Through)
      warnOnce(name, `${name} is not rendered yet: its input passes through unchanged`)
      const made: Record<string, AudioParam> = {}
      params.forEach(([key, value, min, max], i) => {
        made[key] = param(this, i, value, min, max)
        Object.defineProperty(this, key, { value: made[key], enumerable: true })
      })
      initParams(options, made)
      extra?.(this)
    }
  }
  Object.defineProperty(cls, 'name', { value: name })
  tag(cls, name)
  return cls
}

const BiquadFilterNode = passThrough('BiquadFilterNode', [['frequency', 350, 0, 24000], ['detune', 0], ['Q', 1], ['gain', 0]], (node) => {
  let type = 'lowpass'
  Object.defineProperty(node, 'type', { get: () => type, set: (v: string) => { type = String(v) }, enumerable: true })
  Object.defineProperty(node, 'getFrequencyResponse', { value: (_f: Float32Array, mag: Float32Array, phase: Float32Array) => { mag.fill(1); phase.fill(0) } })
})
const DynamicsCompressorNode = passThrough('DynamicsCompressorNode', [['threshold', -24, -100, 0], ['knee', 30, 0, 40], ['ratio', 12, 1, 20], ['attack', 0.003, 0, 1], ['release', 0.25, 0, 1]], (node) => {
  Object.defineProperty(node, 'reduction', { get: () => 0, enumerable: true })
})
const DelayNode = passThrough('DelayNode', [['delayTime', 0, 0, 180]])
const WaveShaperNode = passThrough('WaveShaperNode', [], (node) => {
  let curve: Float32Array | null = null
  let oversample = 'none'
  Object.defineProperty(node, 'curve', { get: () => curve, set: (v: Float32Array | null) => { curve = v }, enumerable: true })
  Object.defineProperty(node, 'oversample', { get: () => oversample, set: (v: string) => { oversample = String(v) }, enumerable: true })
})
const ConvolverNode = passThrough('ConvolverNode', [], (node) => {
  let buffer: AudioBuffer | null = null
  let normalize = true
  Object.defineProperty(node, 'buffer', { get: () => buffer, set: (v: AudioBuffer | null) => { buffer = v }, enumerable: true })
  Object.defineProperty(node, 'normalize', { get: () => normalize, set: (v: boolean) => { normalize = !!v }, enumerable: true })
})
const AnalyserNode = passThrough('AnalyserNode', [], (node) => {
  let fftSize = 2048
  const fields: Record<string, number> = { minDecibels: -100, maxDecibels: -30, smoothingTimeConstant: 0.8 }
  Object.defineProperty(node, 'fftSize', { get: () => fftSize, set: (v: number) => { fftSize = Number(v) }, enumerable: true })
  Object.defineProperty(node, 'frequencyBinCount', { get: () => fftSize / 2, enumerable: true })
  for (const key of Object.keys(fields)) Object.defineProperty(node, key, { get: () => fields[key], set: (v: number) => { fields[key] = Number(v) }, enumerable: true })
  Object.defineProperty(node, 'getFloatFrequencyData', { value: (a: Float32Array) => a.fill(-Infinity) })
  Object.defineProperty(node, 'getByteFrequencyData', { value: (a: Uint8Array) => a.fill(0) })
  Object.defineProperty(node, 'getFloatTimeDomainData', { value: (a: Float32Array) => a.fill(0) })
  Object.defineProperty(node, 'getByteTimeDomainData', { value: (a: Uint8Array) => a.fill(128) })
})

function checkContext(context: unknown): void {
  if (!(context instanceof BaseAudioContext)) throw new TypeError("Failed to construct the node: parameter 1 is not of type 'BaseAudioContext'.")
}

export class AudioBuffer {
  readonly #length: number
  readonly #rate: number
  readonly #count: number
  #native = 0
  #channels: Float32Array[] | null = null

  constructor(options: { length: number; sampleRate: number; numberOfChannels?: number }, decoded?: unknown) {
    const length = Math.trunc(Number(options?.length))
    const rate = Number(options?.sampleRate)
    const count = Math.trunc(Number(options?.numberOfChannels ?? 1))
    if (!(length > 0)) throw new DOMException(`Failed to construct 'AudioBuffer': The number of frames provided (${options?.length}) is less than or equal to the minimum bound (0).`, 'NotSupportedError')
    if (!(rate >= 3000 && rate <= 768000)) throw new DOMException(`Failed to construct 'AudioBuffer': The sample rate provided (${options?.sampleRate}) is outside the range [3000, 768000].`, 'NotSupportedError')
    if (!(count >= 1 && count <= 32)) throw new DOMException(`Failed to construct 'AudioBuffer': The number of channels provided (${options?.numberOfChannels}) is outside the range [1, 32].`, 'NotSupportedError')
    this.#length = length
    this.#rate = rate
    this.#count = count
    if (typeof decoded === 'number' && decoded > 0) {
      this.#native = decoded
      releasedBuffers.register(this, decoded)
    }
  }

  get length(): number {
    return this.#length
  }
  get sampleRate(): number {
    return this.#rate
  }
  get duration(): number {
    return this.#length / this.#rate
  }
  get numberOfChannels(): number {
    return this.#count
  }

  #data(): Float32Array[] {
    if (!this.#channels) {
      const copied = this.#native && native ? native.channelData(this.#native) : []
      this.#channels = Array.from({ length: this.#count }, (_, i) => copied[i] ?? new Float32Array(this.#length))
    }
    return this.#channels
  }

  #channel(what: string, channel: number): Float32Array {
    const c = Math.trunc(Number(channel))
    if (!(c >= 0 && c < this.#count)) throw new DOMException(`Failed to execute '${what}' on 'AudioBuffer': The channel index provided (${channel}) is outside the range [0, ${this.#count - 1}].`, 'IndexSizeError')
    return this.#data()[c]!
  }

  getChannelData(channel: number): Float32Array {
    return this.#channel('getChannelData', channel)
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
    const source = this.#channel('copyFromChannel', channelNumber)
    const offset = Math.max(0, Math.trunc(bufferOffset))
    if (offset >= source.length) return
    destination.set(source.subarray(offset, offset + destination.length))
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
    const target = this.#channel('copyToChannel', channelNumber)
    const offset = Math.max(0, Math.trunc(bufferOffset))
    if (offset >= target.length) return
    target.set(source.subarray(0, target.length - offset), offset)
  }

  [UPLOAD](): number {
    if (!native) return 0
    if (!this.#native) {
      this.#native = newId()
      releasedBuffers.register(this, this.#native)
    }
    if (this.#channels) native.createBuffer(this.#native, this.#rate, this.#channels)
    return this.#native
  }
}
tag(AudioBuffer)

export class BaseAudioContext extends EventTarget {
  readonly [ID]: number
  readonly #destination: AudioDestinationNode
  #state: 'suspended' | 'running' | 'closed' = 'running'
  #frozen = 0

  constructor(token: unknown) {
    illegal(token)
    super()
    if (!native) throw new DOMException("Failed to construct 'AudioContext': audio is not available in this web.", 'NotSupportedError')
    this[ID] = newId()
    const destination = newId()
    native.createContext(this[ID], destination)
    this.#destination = new AudioDestinationNode(KEY, this, 0, 1, 0, destination)
    live.add(this)
  }

  get sampleRate(): number {
    return native?.sampleRate ?? 48000
  }
  get currentTime(): number {
    if (this.#state !== 'running' || !native) return this.#frozen
    return native.time(this[ID])
  }
  get state(): string {
    return this.#state
  }
  get destination(): AudioDestinationNode {
    return this.#destination
  }
  get listener(): object {
    return {}
  }
  get audioWorklet(): undefined {
    return undefined
  }

  protected setState(state: 'suspended' | 'running' | 'closed'): void {
    if (state === this.#state) return
    if (this.#state === 'running') this.#frozen = this.currentTime
    this.#state = state
    if (state === 'closed') live.delete(this)
    later(() => fire(this, new Event('statechange')))
  }

  createGain(): GainNode {
    return new GainNode(this)
  }
  createOscillator(): OscillatorNode {
    return new OscillatorNode(this)
  }
  createBufferSource(): AudioBufferSourceNode {
    return new AudioBufferSourceNode(this)
  }
  createStereoPanner(): StereoPannerNode {
    return new StereoPannerNode(this)
  }
  createConstantSource(): ConstantSourceNode {
    return new ConstantSourceNode(this)
  }
  createBiquadFilter(): AudioNode {
    return new BiquadFilterNode(this)
  }
  createDynamicsCompressor(): AudioNode {
    return new DynamicsCompressorNode(this)
  }
  createDelay(_maxDelayTime?: number): AudioNode {
    return new DelayNode(this)
  }
  createWaveShaper(): AudioNode {
    return new WaveShaperNode(this)
  }
  createConvolver(): AudioNode {
    return new ConvolverNode(this)
  }
  createAnalyser(): AudioNode {
    return new AnalyserNode(this)
  }
  createPeriodicWave(real: ArrayLike<number>, imag: ArrayLike<number>, constraints?: { disableNormalization?: boolean }): PeriodicWave {
    return new PeriodicWave(this, { real, imag, ...constraints })
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new AudioBuffer({ numberOfChannels, length, sampleRate })
  }
  createChannelSplitter(): never {
    throw new DOMException('ChannelSplitterNode is not supported', 'NotSupportedError')
  }
  createChannelMerger(): never {
    throw new DOMException('ChannelMergerNode is not supported', 'NotSupportedError')
  }
  createPanner(): never {
    throw new DOMException('PannerNode is not supported', 'NotSupportedError')
  }
  createScriptProcessor(): never {
    throw new DOMException('ScriptProcessorNode is not supported', 'NotSupportedError')
  }

  decodeAudioData(audioData: ArrayBuffer, successCallback?: ((buffer: AudioBuffer) => void) | null, errorCallback?: ((error: DOMException) => void) | null): Promise<AudioBuffer> {
    if (!(audioData instanceof ArrayBuffer) && !ArrayBuffer.isView(audioData)) {
      return Promise.reject(new TypeError("Failed to execute 'decodeAudioData' on 'BaseAudioContext': parameter 1 is not of type 'ArrayBuffer'."))
    }
    const view = ArrayBuffer.isView(audioData) ? new Uint8Array(audioData.buffer, audioData.byteOffset, audioData.byteLength) : new Uint8Array(audioData)
    const id = newId()
    const decoding = native ? native.decode(id, view.slice()) : Promise.reject(new Error('audio is not available'))
    return decoding.then(
      (info) => {
        const buffer = new AudioBuffer({ length: info.length, sampleRate: info.sampleRate, numberOfChannels: info.numberOfChannels }, id)
        if (typeof successCallback === 'function') successCallback(buffer)
        return buffer
      },
      (error: unknown) => {
        const failure = new DOMException(`Unable to decode audio data: ${(error as Error)?.message ?? error}`, 'EncodingError')
        if (typeof errorCallback === 'function') errorCallback(failure)
        throw failure
      },
    )
  }
}
defineHandlers(BaseAudioContext.prototype, ['statechange'])
tag(BaseAudioContext)

export class AudioContext extends BaseAudioContext {
  constructor(_options?: { latencyHint?: unknown; sampleRate?: number; sinkId?: unknown }) {
    super(KEY)
  }

  get baseLatency(): number {
    return 512 / this.sampleRate
  }
  get outputLatency(): number {
    return 1024 / this.sampleRate
  }
  get sinkId(): string {
    return ''
  }

  resume(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new DOMException('Cannot resume a closed AudioContext.', 'InvalidStateError'))
    if (this.state === 'suspended') {
      native?.setRunning(this[ID], true)
      this.setState('running')
    }
    return Promise.resolve()
  }

  suspend(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new DOMException('Cannot suspend a closed AudioContext.', 'InvalidStateError'))
    if (this.state === 'running') {
      this.setState('suspended')
      native?.setRunning(this[ID], false)
    }
    return Promise.resolve()
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new DOMException('The AudioContext is closed already.', 'InvalidStateError'))
    this.setState('closed')
    native?.closeContext(this[ID])
    return Promise.resolve()
  }

  getOutputTimestamp(): { contextTime: number; performanceTime: number } {
    return { contextTime: this.currentTime, performanceTime: host.now() }
  }

  createMediaElementSource(): never {
    throw new DOMException('MediaElementAudioSourceNode is not supported', 'NotSupportedError')
  }
  createMediaStreamSource(): never {
    throw new DOMException('MediaStreamAudioSourceNode is not supported', 'NotSupportedError')
  }
  createMediaStreamDestination(): never {
    throw new DOMException('MediaStreamAudioDestinationNode is not supported', 'NotSupportedError')
  }
}
tag(AudioContext)

export function installAudio(audio: AudioNative): Record<string, unknown> {
  native = audio
  audio.onEvent((kind, id) => {
    if (kind === 0) {
      const node = playing.get(id)
      if (!node) return
      playing.delete(id)
      node.ended()
    } else if (kind === 1) {
      mediaEvents.ended(id)
    }
  })
  return {
    AudioContext, webkitAudioContext: AudioContext, BaseAudioContext, AudioNode, AudioParam, AudioDestinationNode, AudioScheduledSourceNode,
    OscillatorNode, GainNode, AudioBufferSourceNode, StereoPannerNode, ConstantSourceNode, AudioBuffer, PeriodicWave,
    BiquadFilterNode, DynamicsCompressorNode, DelayNode, WaveShaperNode, ConvolverNode, AnalyserNode,
  }
}
