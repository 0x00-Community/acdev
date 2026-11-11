import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevToolsPage } from '../../src/devtools/index.ts'
import { OverlayDomain, type OverlaySource } from '../../src/devtools/overlay.ts'

function page() {
  const nodes = new Map<number, object>([[4, { id: 4 }], [9, { id: 9 }]])
  const drawn: number[] = []
  let exposed: ((node: unknown) => boolean) | null = null
  const source: OverlaySource = {
    highlight: (id) => void drawn.push(id),
    idOf: (node) => [...nodes].find(([, n]) => n === node)?.[0] ?? -1,
    nodeOf: (id) => nodes.get(id) ?? null,
    expose: (show) => void (exposed = show),
  }
  const sent: { session: number; message: Record<string, unknown> }[] = []
  const devtools = new DevToolsPage('frame', (session, text) => void sent.push({ session, message: JSON.parse(text) as Record<string, unknown> }))
  devtools.use([OverlayDomain.create(source)])
  const call = async (session: number, id: number, method: string, params: object = {}) => {
    devtools.receive(session, JSON.stringify({ id, method, params }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    return sent.filter((s) => s.session === session && s.message['id'] === id).at(-1)!.message
  }
  return { devtools, drawn, call, nodes, exposed: () => exposed! }
}

test('highlightNode draws the node by nodeId or backendNodeId and hideHighlight takes it away', async () => {
  const { drawn, call } = page()
  assert.deepEqual(await call(1, 1, 'Overlay.enable'), { id: 1, result: {} })
  assert.deepEqual(await call(1, 2, 'Overlay.highlightNode', { highlightConfig: {}, nodeId: 4 }), { id: 2, result: {} })
  await call(1, 3, 'Overlay.highlightNode', { highlightConfig: {}, nodeId: 4 })
  await call(1, 4, 'Overlay.highlightNode', { highlightConfig: {}, backendNodeId: 9 })
  assert.deepEqual(await call(1, 5, 'Overlay.hideHighlight'), { id: 5, result: {} })
  await call(1, 6, 'Overlay.hideHighlight')
  assert.deepEqual(drawn, [4, 9, -1], 'the same node is not drawn twice, an empty overlay is not cleared twice')
  const missing = await call(1, 7, 'Overlay.highlightNode', { nodeId: 77 })
  assert.equal((missing['error'] as { code: number }).code, -32000)
  assert.deepEqual(await call(1, 8, 'Overlay.setShowViewportSizeOnResize', { show: true }), { id: 8, result: {} })
})

test('the client that drew the overlay takes it away when it leaves or disables Overlay', async () => {
  const { devtools, drawn, call } = page()
  await call(1, 1, 'Overlay.highlightNode', { nodeId: 4 })
  await call(2, 1, 'Overlay.hideHighlight')
  assert.deepEqual(drawn, [4], 'another client does not clear it')
  devtools.receive(1, null)
  assert.deepEqual(drawn, [4, -1])
  await call(2, 2, 'Overlay.highlightNode', { nodeId: 9 })
  await call(2, 3, 'Overlay.disable')
  assert.deepEqual(drawn, [4, -1, 9, -1])
})

test('a node object from V8 (objectId) is drawn through the exposed function', () => {
  const { drawn, exposed, nodes } = page()
  assert.equal(exposed()(nodes.get(9)), true)
  assert.equal(exposed()({ id: 9 }), false, 'not a node of this page')
  assert.equal(exposed()(42), false)
  assert.deepEqual(drawn, [9])
})
