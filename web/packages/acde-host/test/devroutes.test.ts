import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DevRoutes, type DevRoute } from '../src/devroutes.ts'
import { SourceMaps } from '../src/devlog.ts'
import { DevToolsPage } from '../src/devtools/index.ts'
import { DomDomain, type DomNode, type DomRecord } from '../src/devtools/dom.ts'
import { NetworkDomain } from '../src/devtools/network.ts'
import { PageDomain } from '../src/devtools/page.ts'

const route = (args: Record<string, unknown>, id = 1): DevRoute => DevRoutes.parse(args, id)
const text = (reply: unknown) => {
  assert.ok(reply && typeof reply === 'object' && 'body' in reply)
  return new TextDecoder().decode((reply as { body: Uint8Array }).body)
}

describe('DevRoutes', () => {
  test('glob: ** crosses /, * stays within a segment; a leading / matches path and query, others the whole URL', () => {
    const match = (url: string, href: string) => DevRoutes.matcher(url)(href)
    assert.equal(match('/api/*', 'http://acde.local/api/todos'), true)
    assert.equal(match('/api/*', 'http://acde.local/api/todos?page=2'), true)
    assert.equal(match('/api/*', 'http://acde.local/api/todos/7'), false)
    assert.equal(match('/api/**', 'http://acde.local/api/todos/7'), true)
    assert.equal(match('/api/todos', 'http://acde.local/api/todos?x'), false)
    assert.equal(match('https://example.com/**', 'https://example.com/a/b?c'), true)
    assert.equal(match('https://example.com/**', 'http://example.com/a'), false)
    assert.equal(match('**/v1/(items)', 'https://x.test/v1/(items)'), true)
    assert.equal(DevRoutes.matcher({ regex: 'todos$', flags: 'gi' })('http://acde.local/api/TODOS'), true)
  })

  test('parse fills defaults, lower-cases header names and refuses what would not make a response', () => {
    const r = route({ url: '/x', status: 404, headers: { 'Content-Type': 'text/plain' }, body: btoa('missing'), method: 'post', times: 2 })
    assert.deepEqual({ ...r, url: r.url }, {
      id: 1, url: '/x', method: 'POST', web: null, times: 2, status: 404, statusText: 'Not Found',
      headers: [['content-type', 'text/plain']], body: btoa('missing'), abort: null,
    })
    assert.equal(route({ url: '/x' }).status, 200)
    assert.equal(route({ url: '/x', abort: true }).abort, 'aborted')
    const bad = (args: Record<string, unknown>, message: RegExp) => assert.throws(() => route(args), message)
    bad({}, /url is a glob/)
    bad({ url: { regex: '(' } }, /url: /)
    bad({ url: '/x', status: 101 }, /status is a whole number from 200 to 599/)
    bad({ url: '/x', times: 0 }, /times is a whole number above 0/)
    bad({ url: '/x', body: 'not base64!' }, /body is base64/)
    bad({ url: '/x', headers: { 'bad name': 'v' } }, /is not a token/)
    bad({ url: '/x', abort: true, status: 500 }, /abort cannot come with status/)
    bad({ url: '/x', method: 'GET /' }, /method is an HTTP method/)
  })

  test('match: the newest matching route answers; method filters; times run out and report each use', () => {
    const used: number[] = []
    const routes = new DevRoutes(
      [
        route({ url: '/api/**', body: btoa('old') }, 1),
        route({ url: '/api/todos', body: btoa('new'), times: 2 }, 2),
        route({ url: '/api/todos', method: 'DELETE', abort: 'offline' }, 3),
      ],
      (id) => used.push(id),
    )
    assert.equal(text(routes.match('GET', 'http://acde.local/api/todos')), 'new')
    assert.deepEqual(routes.match('delete', 'http://acde.local/api/todos'), { error: 'offline' })
    assert.equal(text(routes.match('GET', 'http://acde.local/api/todos')), 'new')
    assert.equal(text(routes.match('GET', 'http://acde.local/api/todos')), 'old')
    assert.deepEqual(used, [2, 2])
    assert.equal(routes.match('GET', 'http://acde.local/other'), null)
    routes.set([])
    assert.equal(routes.match('GET', 'http://acde.local/api/todos'), null)
  })
})

describe('SourceMaps', () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const files: Record<string, string> = {
    'http://acde.local/assets/main.js': 'function f(){throw new Error("x")}\n//# sourceMappingURL=main.js.map\n',
    'http://acde.local/assets/main.js.map': JSON.stringify({ version: 3, sources: ['../src/main.ts'], mappings: 'UAEI' }),
    'http://acde.local/assets/plain.js': 'function g(){}\n',
  }
  const read = (url: string) => (url in files ? encode(files[url]!) : null)
  const maps = new SourceMaps((url) => (url.endsWith('.map') ? null : read(url)), (url) => (url.endsWith('.map') ? read(url) : null))

  test('stack frames in files with a map point at the source', () => {
    const stack = 'Error: x\n    at f (http://acde.local/assets/main.js:1:12)\n    at http://acde.local/assets/plain.js:1:3'
    assert.equal(maps.stack(stack), 'Error: x\n    at f (src/main.ts:3:5)\n    at http://acde.local/assets/plain.js:1:3')
  })

  test('text without frames, or frames before any mapping, is kept', () => {
    assert.equal(maps.stack('just text'), 'just text')
    assert.equal(maps.stack('at http://acde.local/assets/main.js:1:3'), 'at http://acde.local/assets/main.js:1:3')
  })
})

describe('DevTools domains served by the page', () => {
  const devtools = () => {
    const sent: [number, Record<string, unknown>][] = []
    let handler: ((session: number, text: string | null) => void) | null = null
    const host = {
      devtoolsHandler: (fn: (session: number, text: string | null) => void) => ((handler = fn), 'alpha#1'),
      devtoolsSend: (session: number, text: string) => void sent.push([session, JSON.parse(text) as Record<string, unknown>]),
    }
    const page = DevToolsPage.install(host, (page) => [PageDomain.create(page.frameId, () => 'http://app.acde/index.html')])
    const ask = async (session: number, message: Record<string, unknown>) => {
      handler!(session, JSON.stringify(message))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { sent, page: page!, ask, end: (session: number) => handler!(session, null) }
  }

  test('Page answers the frame tree with the web name as the frame id', async () => {
    const { sent, ask } = devtools()
    await ask(4, { id: 1, method: 'Page.enable' })
    await ask(4, { id: 2, method: 'Page.getFrameTree', sessionId: 's' })
    await ask(4, { id: 3, method: 'Page.getResourceTree' })
    assert.deepEqual(sent[0], [4, { id: 1, result: {} }])
    const [, tree] = sent[1]!
    assert.equal(tree['sessionId'], 's')
    const frame = (tree['result'] as { frameTree: { frame: Record<string, unknown> } }).frameTree.frame
    assert.deepEqual([frame['id'], frame['url'], frame['securityOrigin']], ['alpha#1', 'http://app.acde/index.html', 'http://app.acde'])
    assert.deepEqual((sent[2]![1]['result'] as { frameTree: { resources: unknown[] } }).frameTree.resources, [])
  })

  test('an unknown method answers -32601 and the session keeps working', async () => {
    const { sent, ask } = devtools()
    await ask(1, { id: 1, method: 'Page.reload' })
    await ask(1, { id: 2, method: 'DOM.getDocument' })
    await ask(1, { id: 3, method: 'Page.getFrameTree' })
    assert.deepEqual(sent.map(([, m]) => (m['error'] as { code?: number } | undefined)?.code ?? 'ok'), [-32601, -32601, 'ok'])
  })

  test('events reach only the sessions that enabled the domain, and an ended session is forgotten', async () => {
    const { sent, page, ask, end } = devtools()
    await ask(1, { id: 1, method: 'Page.enable' })
    await ask(2, { id: 1, method: 'Page.getFrameTree' })
    await ask(3, { id: 1, method: 'Page.enable' })
    end(3)
    sent.length = 0
    page.emit('Page', 'frameNavigated', { frame: { id: 'alpha#1' } })
    assert.deepEqual(sent, [[1, { method: 'Page.frameNavigated', params: { frame: { id: 'alpha#1' } } }]])
  })

  test('without the host side nothing is installed', () => {
    assert.equal(DevToolsPage.install({}, () => []), null)
    assert.equal(DevToolsPage.install({ devtoolsHandler: () => undefined, devtoolsSend: () => {} }, () => []), null)
  })
})

class FakeNode implements DomNode {
  static #next = 1
  readonly id = FakeNode.#next++
  readonly childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  attributes: { name: string; value: string }[] | null

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public nodeValue: string | null = null,
    attributes: Record<string, string> | null = nodeType === 1 ? {} : null,
  ) {
    this.attributes = attributes && Object.entries(attributes).map(([name, value]) => ({ name, value }))
  }

  get localName(): string {
    return this.nodeName.toLowerCase()
  }

  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) - 1] ?? null
  }

  append(...nodes: FakeNode[]): this {
    for (const node of nodes) {
      node.parentNode = this
      this.childNodes.push(node)
    }
    return this
  }
}

describe('DOM domain served by the page', () => {
  const tree = () => {
    const title = new FakeNode(1, 'H1', null, { class: 'big' }).append(new FakeNode(3, '#text', 'Hello'))
    const body = new FakeNode(1, 'BODY').append(new FakeNode(3, '#text', '\n  '), title)
    const html = new FakeNode(1, 'HTML', null, { lang: 'en' }).append(new FakeNode(1, 'HEAD'), body)
    const document = new FakeNode(9, '#document').append(new FakeNode(10, 'html'), html)
    const nodes = new Map<number, FakeNode>()
    const index = (node: FakeNode) => {
      nodes.set(node.id, node)
      node.childNodes.forEach(index)
    }
    index(document)
    let changed: ((records: readonly DomRecord[]) => void) | null = null
    let lookup: ((id: number) => DomNode) | null = null
    const source = {
      document: () => document,
      idOf: (node: DomNode) => (node as FakeNode).id,
      nodeOf: (id: number) => nodes.get(id) ?? null,
      observe: (fn: (records: readonly DomRecord[]) => void) => ((changed = fn), () => void (changed = null)),
      expose: (fn: (id: number) => DomNode) => void (lookup = fn),
    }
    const sent: Record<string, unknown>[] = []
    let handler: ((session: number, text: string | null) => void) | null = null
    const host = {
      devtoolsHandler: (fn: (session: number, text: string | null) => void) => ((handler = fn), 'alpha#1'),
      devtoolsSend: (_: number, text: string) => void sent.push(JSON.parse(text) as Record<string, unknown>),
    }
    DevToolsPage.install(host, (page) => [DomDomain.create(source, (method, params) => page.emit('DOM', method, params))])
    const ask = async (message: Record<string, unknown>) => {
      handler!(1, JSON.stringify(message))
      await new Promise((resolve) => setTimeout(resolve, 0))
      return sent.at(-1)!
    }
    const mutate = (records: DomRecord[]) => changed!(records)
    return { document, html, body, title, sent, ask, mutate, lookup: () => lookup, observing: () => changed !== null }
  }
  type Described = { nodeId: number; nodeName: string; attributes?: string[]; childNodeCount: number; children?: Described[]; nodeValue: string }

  test('getDocument gives the tree with node ids, attributes and text; blank text is left out', async () => {
    const { document, html, body, title, ask, observing, lookup } = tree()
    const reply = await ask({ id: 1, method: 'DOM.getDocument', params: { depth: -1 } })
    const root = (reply['result'] as { root: Described }).root
    assert.equal(root.nodeId, document.id)
    assert.deepEqual(
      root.children!.map((c) => c.nodeName),
      ['html', 'HTML'],
    )
    const htmlNode = root.children![1]!
    assert.deepEqual([htmlNode.nodeId, htmlNode.attributes], [html.id, ['lang', 'en']])
    const bodyNode = htmlNode.children![1]!
    assert.deepEqual([bodyNode.nodeId, bodyNode.childNodeCount], [body.id, 1])
    const h1 = bodyNode.children![0]!
    assert.deepEqual([h1.nodeId, h1.attributes, h1.children![0]!.nodeValue], [title.id, ['class', 'big'], 'Hello'])
    assert.ok(observing(), 'getDocument starts watching the page')
    assert.equal(lookup()!(title.id), title)
  })

  test('requestChildNodes and describeNode answer from the page', async () => {
    const { html, body, sent, ask } = tree()
    await ask({ id: 1, method: 'DOM.getDocument' })
    await ask({ id: 2, method: 'DOM.requestChildNodes', params: { nodeId: body.id } })
    const event = sent.find((m) => m['method'] === 'DOM.setChildNodes')!
    assert.equal((event['params'] as { parentId: number }).parentId, body.id)
    const described = await ask({ id: 3, method: 'DOM.describeNode', params: { backendNodeId: html.id } })
    assert.equal((described['result'] as { node: Described }).node.nodeName, 'HTML')
    const missing = await ask({ id: 4, method: 'DOM.describeNode', params: { nodeId: 9999 } })
    assert.equal((missing['error'] as { code: number }).code, -32000)
  })

  test('page changes reach the open tree as DOM events', async () => {
    const { body, title, sent, ask, mutate } = tree()
    await ask({ id: 1, method: 'DOM.getDocument', params: { depth: -1 } })
    sent.length = 0
    const added = new FakeNode(1, 'P')
    body.append(added)
    mutate([{ type: 'childList', target: body, addedNodes: [added], removedNodes: [], attributeName: null }])
    title.attributes = [{ name: 'class', value: 'small' }]
    mutate([{ type: 'attributes', target: title, addedNodes: [], removedNodes: [], attributeName: 'class' }])
    const text = title.childNodes[0]!
    text.nodeValue = 'Bye'
    mutate([{ type: 'characterData', target: text, addedNodes: [], removedNodes: [], attributeName: null }])
    body.childNodes.splice(body.childNodes.indexOf(added), 1)
    mutate([{ type: 'childList', target: body, addedNodes: [], removedNodes: [added], attributeName: null }])
    assert.deepEqual(
      sent.map((m) => m['method']),
      ['DOM.childNodeInserted', 'DOM.attributeModified', 'DOM.characterDataModified', 'DOM.childNodeRemoved'],
    )
    const inserted = sent[0]!['params'] as { parentNodeId: number; previousNodeId: number; node: Described }
    assert.deepEqual([inserted.parentNodeId, inserted.previousNodeId, inserted.node.nodeId], [body.id, title.id, added.id])
    assert.deepEqual(sent[1]!['params'], { nodeId: title.id, name: 'class', value: 'small' })
    assert.deepEqual(sent[2]!['params'], { nodeId: text.id, characterData: 'Bye' })
    assert.deepEqual(sent[3]!['params'], { parentNodeId: body.id, nodeId: added.id })
  })

  test('editing is refused as read only, and disable stops watching', async () => {
    const { title, ask, observing } = tree()
    await ask({ id: 1, method: 'DOM.enable' })
    const edit = await ask({ id: 2, method: 'DOM.setAttributeValue', params: { nodeId: title.id, name: 'id', value: 'x' } })
    assert.match((edit['error'] as { message: string }).message, /read only/)
    assert.deepEqual(title.attributes, [{ name: 'class', value: 'big' }])
    await ask({ id: 3, method: 'DOM.disable' })
    assert.equal(observing(), false)
  })
})

describe('DevTools Network domain', () => {
  const network = (limit = NetworkDomain.BODIES) => {
    const sent: Record<string, unknown>[] = []
    let handler: ((session: number, text: string | null) => void) | null = null
    let domain: NetworkDomain | null = null
    const host = {
      devtoolsHandler: (fn: (session: number, text: string | null) => void) => ((handler = fn), 'alpha#1'),
      devtoolsSend: (_: number, text: string) => void sent.push(JSON.parse(text) as Record<string, unknown>),
    }
    DevToolsPage.install(host, (page) => {
      domain = new NetworkDomain(page, () => 'http://app.acde/', limit, () => 1)
      return [domain.domain()]
    })
    const ask = async (message: Record<string, unknown>) => {
      handler!(1, JSON.stringify(message))
      await new Promise((resolve) => setTimeout(resolve, 0))
      return sent.find((m) => m['id'] === message['id'])
    }
    const events = (method: string) => sent.filter((m) => m['method'] === `Network.${method}`).map((m) => m['params'] as Record<string, unknown>)
    return { sent, ask, events, observer: domain!.observer }
  }
  const bytes = (text: string) => new TextEncoder().encode(text)

  test('nothing is recorded until a client enables Network', async () => {
    const { observer, ask, sent } = network()
    assert.equal(observer.recording(), false)
    await ask({ id: 1, method: 'Network.enable' })
    assert.equal(observer.recording(), true)
    await ask({ id: 2, method: 'Network.disable' })
    assert.equal(observer.recording(), false)
    assert.deepEqual(sent.map((m) => m['id']), [1, 2])
  })

  test('a fetch reports its request, response, data and end, and its text body is kept', async () => {
    const { observer, ask, events } = network()
    await ask({ id: 1, method: 'Network.enable' })
    observer.start(7, 'fetch', 'POST', 'http://app.acde/api', [['content-type', 'application/json']], bytes('{"a":1}'))
    observer.response(7, 201, 'Created', [['Content-Type', 'application/json; charset=utf-8'], ['x-a', '1']])
    observer.data(7, bytes('{"ok":'))
    observer.data(7, bytes('true}'))
    observer.end(7, 11)
    const [sent] = events('requestWillBeSent')
    assert.deepEqual([sent!['requestId'], sent!['type'], sent!['frameId'], sent!['loaderId']], ['7', 'Fetch', 'alpha#1', 'alpha#1'])
    assert.deepEqual(sent!['request'], {
      url: 'http://app.acde/api', method: 'POST', headers: { 'content-type': 'application/json' }, initialPriority: 'High',
      referrerPolicy: 'strict-origin-when-cross-origin', hasPostData: true, postData: '{"a":1}',
    })
    const response = events('responseReceived')[0]!['response'] as Record<string, unknown>
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'x-a': '1' }
    assert.deepEqual([response['status'], response['statusText'], response['mimeType'], response['headers']], [201, 'Created', 'application/json', headers])
    assert.equal(events('dataReceived').length, 2)
    assert.deepEqual(events('loadingFinished'), [{ requestId: '7', timestamp: 1, encodedDataLength: 11 }])
    const body = await ask({ id: 2, method: 'Network.getResponseBody', params: { requestId: '7' } })
    assert.deepEqual(body!['result'], { body: '{"ok":true}', base64Encoded: false })
  })

  test('a binary body comes back as base64, an XHR is typed XHR, and a failure carries its error text', async () => {
    const { observer, ask, events } = network()
    await ask({ id: 1, method: 'Network.enable' })
    observer.start(1, 'xhr', 'GET', 'http://app.acde/a.png', [], null)
    observer.response(1, 200, 'OK', [['content-type', 'image/png']])
    observer.data(1, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    observer.end(1, 4)
    observer.start(2, 'fetch', 'GET', 'https://elsewhere.example/', [], null)
    observer.error(2, 'this app has no network capability')
    observer.start(3, 'fetch', 'GET', 'http://app.acde/slow', [], null)
    observer.error(3, 'aborted')
    observer.start(4, 'websocket', 'GET', 'ws://app.acde/', [], null)
    assert.equal(events('requestWillBeSent')[0]!['type'], 'XHR')
    const image = await ask({ id: 2, method: 'Network.getResponseBody', params: { requestId: '1' } })
    assert.deepEqual(image!['result'], { body: 'iVBORw==', base64Encoded: true })
    assert.deepEqual(events('loadingFailed'), [
      { requestId: '2', timestamp: 1, type: 'Fetch', errorText: 'this app has no network capability' },
      { requestId: '3', timestamp: 1, type: 'Fetch', errorText: 'aborted', canceled: true },
    ])
    assert.equal(events('requestWillBeSent').length, 3, 'other kinds are left for later')
  })

  test('kept bodies are bounded per page and the oldest go first', async () => {
    const { observer, ask } = network(10)
    await ask({ id: 1, method: 'Network.enable' })
    for (const id of [1, 2]) {
      observer.start(id, 'fetch', 'GET', `http://app.acde/${id}`, [], null)
      observer.response(id, 200, 'OK', [['content-type', 'text/plain']])
      observer.data(id, bytes('123456'))
      observer.end(id, 6)
    }
    assert.equal(((await ask({ id: 2, method: 'Network.getResponseBody', params: { requestId: '1' } }))!['error'] as { code: number }).code, -32000)
    assert.deepEqual((await ask({ id: 3, method: 'Network.getResponseBody', params: { requestId: '2' } }))!['result'], { body: '123456', base64Encoded: false })
  })
})
