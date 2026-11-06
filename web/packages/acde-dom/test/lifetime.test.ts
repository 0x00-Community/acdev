import assert from 'node:assert/strict'
import { test } from 'node:test'
import { page, type Web } from './harness.ts'

async function collect(web: Web): Promise<void> {
  for (let i = 0; i < 3; i++) {
    web.host.gc()
    await web.wait(5)
  }
}

test('one wrapper per node; expandos and listeners of connected nodes survive GC', { skip: typeof globalThis.gc !== 'function' && 'needs --expose-gc' }, async () => {
  using web = await page('<!doctype html><html><body><div id="keep"><span>x</span></div></body></html>')
  web.run(`
    const keep = document.getElementById('keep')
    keep.__reactFiber$abc = { tag: 5 }
    keep.firstChild.custom = 'span expando'
    keep.addEventListener('ping', () => { globalThis.pinged = (globalThis.pinged || 0) + 1 })
    const made = document.createElement('p')
    made.mark = 'made'
    keep.appendChild(made)
  `)
  await collect(web)
  assert.equal(web.run('document.getElementById("keep").__reactFiber$abc.tag'), 5)
  assert.equal(web.run('document.querySelector("#keep span").custom'), 'span expando')
  assert.equal(web.run('document.querySelector("#keep p").mark'), 'made')
  assert.equal(web.run('document.getElementById("keep") === document.body.firstChild'), true)
  web.run('document.querySelector("#keep span").dispatchEvent(new Event("ping", { bubbles: true }))')
  assert.equal(web.run('pinged'), 1)
})

test('detached wrappers nobody holds are collected and their nodes freed; held ones stay', { skip: typeof globalThis.gc !== 'function' && 'needs --expose-gc' }, async () => {
  using web = await page('<!doctype html><html><body><ul id="list"></ul></body></html>')
  const before = web.internals.stats()
  web.run(`
    for (let i = 0; i < 500; i++) { const d = document.createElement('div'); d.textContent = 'x' + i }
    globalThis.held = document.createElement('section')
    held.expando = 'still here'
    held.appendChild(document.createElement('i'))
    const list = document.getElementById('list')
    for (let i = 0; i < 50; i++) list.appendChild(document.createElement('li'))
    list.replaceChildren()
  `)
  web.endTask()
  const freedBefore = web.dom.freed.size
  await collect(web)
  const after = web.internals.stats()
  assert.ok(web.dom.freed.size - freedBefore >= 500, `freed ${web.dom.freed.size - freedBefore}`)
  assert.ok(after.weak < 60, `weak wrappers left: ${after.weak}`)
  assert.ok(after.strong <= before.strong + 2, `strong ${before.strong} → ${after.strong}`)
  assert.equal(web.run('held.expando'), 'still here')
  assert.equal(web.run('held.firstChild.localName'), 'i')
  web.run('document.body.appendChild(held)')
  assert.equal(web.run('document.querySelector("section i") === held.firstChild'), true)
})

test('moving between connected and detached keeps the same wrapper', async () => {
  using web = await page('<!doctype html><html><body><div id="a"><b id="b">b</b></div></body></html>')
  const same = web.run(`(() => {
    const b = document.getElementById('b')
    b.tag = 1
    const parent = b.parentNode
    b.remove()
    const detached = !b.isConnected
    const box = document.createElement('div')
    box.appendChild(b)
    document.body.appendChild(box)
    return detached && b.isConnected && document.getElementById('b') === b && b.tag === 1 && parent.id === 'a'
  })()`)
  assert.equal(same, true)
})
