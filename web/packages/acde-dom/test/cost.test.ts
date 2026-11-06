import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callsOf, loadReact, page } from './harness.ts'

test('React mounting 2000 elements costs a few native calls each', async () => {
  using web = await page('<!doctype html><html><body><div id="root"></div><p id="sel">text</p></body></html>')
  loadReact(web)
  web.run('getSelection().collapse(document.getElementById("sel").firstChild, 1)')
  const start = performance.now()
  const counted = callsOf(web, `
    const h = React.createElement
    globalThis.root = ReactDOMClient.createRoot(document.getElementById('root'))
    React.act(() => root.render(h('ul', null, Array.from({ length: 2000 }, (_, i) => h('li', { key: i, className: 'row', title: 't' + i }, 'item ', i)))))
  `)
  const ms = performance.now() - start
  const calls = [...counted.values()].reduce((a, b) => a + b, 0)
  const perNode = calls / 2000
  const top = [...counted].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(`React mount, 2000 <li>: ${calls} native calls (${perNode.toFixed(2)} per <li>), ${ms.toFixed(0)} ms on the happy-dom mock; top: ${top}`)
  assert.equal(web.run('document.querySelectorAll("li").length'), 2000)
  assert.ok(perNode < 9, `${perNode} native calls per element`)
})
