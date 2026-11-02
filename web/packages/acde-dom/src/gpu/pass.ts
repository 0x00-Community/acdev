import { DOMException } from '../core/exception'
import { tag } from '../core/host'
import type { GpuNative } from '../native'

export const ID = Symbol('gpu id')

export interface Owned {
  readonly [ID]: number
}

class Recorder {
  #data = new Float64Array(256)
  length = 0
  strings: string[] = []

  op(...values: number[]): void {
    const end = this.length + values.length
    if (end > this.#data.length) {
      const bigger = new Float64Array(Math.max(end, this.#data.length * 2))
      bigger.set(this.#data.subarray(0, this.length))
      this.#data = bigger
    }
    this.#data.set(values, this.length)
    this.length = end
  }

  string(text: unknown): number {
    this.strings.push(String(text))
    return this.strings.length - 1
  }

  get data(): Float64Array {
    return this.#data
  }
}

export const idOf = (object: unknown): number => (object && typeof object === 'object' && ID in object ? (object as Owned)[ID] : 0)

function offsets(dynamic?: Iterable<number> | ArrayLike<number>, start = 0, length?: number): number[] {
  if (!dynamic) return []
  const list = Array.from(dynamic as ArrayLike<number>)
  return length === undefined ? list.slice(start) : list.slice(start, start + length)
}

abstract class Encoding {
  label: string
  protected readonly gpu: GpuNative
  protected readonly device: number
  protected readonly rec = new Recorder()
  #ended = false

  constructor(gpu: GpuNative, device: number, label: string) {
    this.gpu = gpu
    this.device = device
    this.label = label
  }

  protected live(): Recorder | null {
    return this.#ended ? null : this.rec
  }

  protected close(): Recorder | null {
    if (this.#ended) return null
    this.#ended = true
    return this.rec
  }

  setBindGroup(index: number, group: unknown, dynamicOffsets?: Iterable<number> | ArrayLike<number>, start?: number, length?: number): void {
    const o = offsets(dynamicOffsets, start, length)
    this.live()?.op(2, index, idOf(group), o.length, ...o)
  }

  pushDebugGroup(label: string): void {
    const r = this.live()
    r?.op(16, r.string(label))
  }

  popDebugGroup(): void {
    this.live()?.op(17)
  }

  insertDebugMarker(label: string): void {
    const r = this.live()
    r?.op(18, r.string(label))
  }
}

abstract class RenderEncoding extends Encoding {
  setPipeline(pipeline: unknown): void {
    this.live()?.op(1, idOf(pipeline))
  }

  setVertexBuffer(slot: number, buffer: unknown, offset = 0, size?: number): void {
    this.live()?.op(3, slot, idOf(buffer), offset, size ?? -1)
  }

  setIndexBuffer(buffer: unknown, format: string, offset = 0, size?: number): void {
    if (format !== 'uint16' && format !== 'uint32') throw new TypeError(`'${format}' is not a GPUIndexFormat`)
    this.live()?.op(4, idOf(buffer), format === 'uint32' ? 1 : 0, offset, size ?? -1)
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.live()?.op(5, vertexCount, instanceCount, firstVertex, firstInstance)
  }

  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    this.live()?.op(6, indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
  }

  drawIndirect(buffer: unknown, offset: number): void {
    this.live()?.op(7, idOf(buffer), offset)
  }

  drawIndexedIndirect(buffer: unknown, offset: number): void {
    this.live()?.op(8, idOf(buffer), offset)
  }
}

export class GPURenderPassEncoder extends RenderEncoding {
  readonly #encoder: number
  readonly #descriptor: string

  constructor(gpu: GpuNative, device: number, encoder: number, descriptor: string, label: string) {
    super(gpu, device, label)
    this.#encoder = encoder
    this.#descriptor = descriptor
  }

  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void {
    this.live()?.op(9, x, y, width, height, minDepth, maxDepth)
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    this.live()?.op(10, x, y, width, height)
  }

  setBlendConstant(color: unknown): void {
    const [r, g, b, a] = colorOf(color)
    this.live()?.op(11, r, g, b, a)
  }

  setStencilReference(reference: number): void {
    this.live()?.op(12, reference)
  }

  beginOcclusionQuery(index: number): void {
    this.live()?.op(13, index)
  }

  endOcclusionQuery(): void {
    this.live()?.op(14)
  }

  executeBundles(bundles: Iterable<unknown>): void {
    const ids = Array.from(bundles, idOf)
    this.live()?.op(15, ids.length, ...ids)
  }

  end(): void {
    const r = this.close()
    if (!r) return
    this.gpu.renderPass(this.device, this.#encoder, this.#descriptor, r.data, r.length, r.strings)
  }
}
tag(GPURenderPassEncoder)

export class GPUComputePassEncoder extends Encoding {
  readonly #encoder: number
  readonly #descriptor: string

  constructor(gpu: GpuNative, device: number, encoder: number, descriptor: string, label: string) {
    super(gpu, device, label)
    this.#encoder = encoder
    this.#descriptor = descriptor
  }

  setPipeline(pipeline: unknown): void {
    this.live()?.op(1, idOf(pipeline))
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.live()?.op(19, x, y, z)
  }

  dispatchWorkgroupsIndirect(buffer: unknown, offset: number): void {
    this.live()?.op(20, idOf(buffer), offset)
  }

  end(): void {
    const r = this.close()
    if (!r) return
    this.gpu.computePass(this.device, this.#encoder, this.#descriptor, r.data, r.length, r.strings)
  }
}
tag(GPUComputePassEncoder)

export class GPURenderBundleEncoder extends RenderEncoding {
  readonly #descriptor: string
  readonly #make: (bundle: number, label: string) => unknown

  constructor(gpu: GpuNative, device: number, descriptor: string, label: string, make: (bundle: number, label: string) => unknown) {
    super(gpu, device, label)
    this.#descriptor = descriptor
    this.#make = make
  }

  finish(descriptor: { label?: string } = {}): unknown {
    const r = this.close()
    if (!r) throw new DOMException('The render bundle encoder is finished', 'InvalidStateError')
    const label = descriptor.label ?? ''
    return this.#make(this.gpu.createRenderBundle(this.device, this.#descriptor, r.data, r.length, r.strings), label)
  }
}
tag(GPURenderBundleEncoder)

export function colorOf(color: unknown): [number, number, number, number] {
  if (color && typeof color === 'object' && Symbol.iterator in color) {
    const list = Array.from(color as Iterable<number>, Number)
    if (list.length !== 4) throw new TypeError('A GPUColor sequence has 4 numbers')
    return list as [number, number, number, number]
  }
  const c = (color ?? {}) as { r?: number; g?: number; b?: number; a?: number }
  for (const k of ['r', 'g', 'b', 'a'] as const) if (c[k] === undefined) throw new TypeError(`GPUColor is missing '${k}'`)
  return [Number(c.r), Number(c.g), Number(c.b), Number(c.a)]
}
