import { DevToolsError, type DevToolsDomain, type DevToolsParams, type DevToolsSession } from './index'

export interface DomNode {
  readonly nodeType: number
  readonly nodeName: string
  readonly localName?: string | null
  readonly nodeValue: string | null
  readonly childNodes: ArrayLike<DomNode>
  readonly parentNode: DomNode | null
  readonly previousSibling: DomNode | null
  readonly attributes?: ArrayLike<{ readonly name: string; readonly value: string }> | null
  readonly publicId?: string
  readonly systemId?: string
  readonly documentURI?: string
  readonly baseURI?: string
}

export interface DomRecord {
  readonly type: string
  readonly target: DomNode
  readonly addedNodes: ArrayLike<DomNode>
  readonly removedNodes: ArrayLike<DomNode>
  readonly attributeName: string | null
}

export interface DomSource {
  document(): DomNode
  idOf(node: DomNode): number
  nodeOf(id: number): DomNode | null
  observe(changed: (records: readonly DomRecord[]) => void): () => void
  expose(lookup: (id: number) => DomNode): void
}

type Emit = (method: string, params: DevToolsParams) => void

const TEXT = 3
const ELEMENT = 1
const DOCUMENT_TYPE = 10
const DOCUMENT = 9
const READ_ONLY = 'the Elements panel shows the page read only; change the page from its code or the console'
const EDITS = [
  'setAttributeValue',
  'setAttributesAsText',
  'removeAttribute',
  'setNodeName',
  'setNodeValue',
  'setOuterHTML',
  'removeNode',
  'moveTo',
  'copyTo',
  'undo',
  'redo',
  'markUndoableState',
  'setFileInputFiles',
]

export class DomDomain {
  readonly #source: DomSource
  readonly #emit: Emit
  readonly #sessions = new Set<number>()
  readonly #expanded = new Set<number>()
  #stop: (() => void) | null = null

  constructor(source: DomSource, emit: Emit) {
    this.#source = source
    this.#emit = emit
    source.expose((id) => {
      const node = source.nodeOf(id)
      if (!node) throw new Error(`no node ${id} in this page`)
      return node
    })
  }

  static create(source: DomSource, emit: Emit): DevToolsDomain {
    const domain = new DomDomain(source, emit)
    const methods: Record<string, (params: DevToolsParams, session: DevToolsSession) => unknown> = {
      enable: (_, session) => domain.#enable(session),
      disable: (_, session) => domain.#disable(session),
      getDocument: (params, session) => domain.#document(params, session),
      requestChildNodes: (params) => domain.#children(params),
      describeNode: (params) => ({ node: domain.#describe(domain.#node(params), DomDomain.#depth(params, 0)) }),
      resolveNode: () => {
        throw new DevToolsError(-32000, 'resolveNode is answered by the runtime')
      },
      pushNodesByBackendIdsToFrontend: (params) => ({ backendNodeIds: params['backendNodeIds'] ?? [] }),
    }
    for (const name of EDITS) {
      methods[name] = () => {
        throw new DevToolsError(-32000, READ_ONLY)
      }
    }
    return { name: 'DOM', methods }
  }

  #enable(session: DevToolsSession): void {
    session.enabled.add('DOM')
    this.#sessions.add(session.id)
    this.#stop ??= this.#source.observe((records) => this.#changed(records))
  }

  #disable(session: DevToolsSession): void {
    session.enabled.delete('DOM')
    this.#sessions.delete(session.id)
    if (this.#sessions.size === 0) {
      this.#stop?.()
      this.#stop = null
      this.#expanded.clear()
    }
  }

  #document(params: DevToolsParams, session: DevToolsSession): unknown {
    if (!this.#sessions.has(session.id)) this.#enable(session)
    this.#expanded.clear()
    return { root: this.#describe(this.#source.document(), DomDomain.#depth(params, 2)) }
  }

  #children(params: DevToolsParams): void {
    const parent = this.#node(params)
    const id = this.#source.idOf(parent)
    this.#expanded.add(id)
    const depth = DomDomain.#depth(params, 1)
    this.#emit('setChildNodes', { parentId: id, nodes: this.#shown(parent).map((child) => this.#describe(child, depth - 1)) })
  }

  #node(params: DevToolsParams): DomNode {
    const id = Number(params['nodeId'] ?? params['backendNodeId'])
    const node = Number.isInteger(id) ? this.#source.nodeOf(id) : null
    if (!node) throw new DevToolsError(-32000, 'Could not find node with given id')
    return node
  }

  static #depth(params: DevToolsParams, fallback: number): number {
    const depth = params['depth']
    if (depth === -1) return Number.POSITIVE_INFINITY
    return typeof depth === 'number' && depth >= 0 ? depth : fallback
  }

  #shown(node: DomNode): DomNode[] {
    const out: DomNode[] = []
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i]!
      if (child.nodeType === TEXT && !(child.nodeValue ?? '').trim()) continue
      out.push(child)
    }
    return out
  }

  #describe(node: DomNode, depth: number): Record<string, unknown> {
    const id = this.#source.idOf(node)
    const shown = this.#shown(node)
    const out: Record<string, unknown> = {
      nodeId: id,
      backendNodeId: id,
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: node.nodeType === ELEMENT ? (node.localName ?? '') : '',
      nodeValue: node.nodeValue ?? '',
      childNodeCount: shown.length,
    }
    if (node.parentNode) out['parentId'] = this.#source.idOf(node.parentNode)
    if (node.attributes) out['attributes'] = Array.from(node.attributes).flatMap((a) => [a.name, a.value])
    if (node.nodeType === DOCUMENT) Object.assign(out, { documentURL: node.documentURI ?? '', baseURL: node.baseURI ?? '', xmlVersion: '' })
    if (node.nodeType === DOCUMENT_TYPE) Object.assign(out, { publicId: node.publicId ?? '', systemId: node.systemId ?? '' })
    if (depth > 0 && shown.length) {
      this.#expanded.add(id)
      out['children'] = shown.map((child) => this.#describe(child, depth - 1))
    }
    return out
  }

  #previous(node: DomNode): number {
    let previous = node.previousSibling
    while (previous && previous.nodeType === TEXT && !(previous.nodeValue ?? '').trim()) previous = previous.previousSibling
    return previous ? this.#source.idOf(previous) : 0
  }

  #changed(records: readonly DomRecord[]): void {
    for (const record of records) {
      const target = this.#source.idOf(record.target)
      if (record.type === 'attributes' && record.attributeName) {
        const value = record.target.attributes ? Array.from(record.target.attributes).find((a) => a.name === record.attributeName) : undefined
        if (value) this.#emit('attributeModified', { nodeId: target, name: record.attributeName, value: value.value })
        else this.#emit('attributeRemoved', { nodeId: target, name: record.attributeName })
        continue
      }
      if (record.type === 'characterData') {
        this.#emit('characterDataModified', { nodeId: target, characterData: record.target.nodeValue ?? '' })
        continue
      }
      if (record.type !== 'childList') continue
      if (!this.#expanded.has(target)) {
        this.#emit('childNodeCountUpdated', { nodeId: target, childNodeCount: this.#shown(record.target).length })
        continue
      }
      for (let i = 0; i < record.removedNodes.length; i++) {
        const node = record.removedNodes[i]!
        if (node.nodeType === TEXT && !(node.nodeValue ?? '').trim()) continue
        this.#emit('childNodeRemoved', { parentNodeId: target, nodeId: this.#source.idOf(node) })
      }
      for (let i = 0; i < record.addedNodes.length; i++) {
        const node = record.addedNodes[i]!
        if (node.parentNode !== record.target || (node.nodeType === TEXT && !(node.nodeValue ?? '').trim())) continue
        this.#emit('childNodeInserted', { parentNodeId: target, previousNodeId: this.#previous(node), node: this.#describe(node, 0) })
      }
    }
  }
}
