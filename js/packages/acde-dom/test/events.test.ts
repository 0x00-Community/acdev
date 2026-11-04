import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWeb } from './harness.ts'

const PAGE = '<!doctype html><html><body><div id="outer"><div id="inner"><span id="leaf">x</span></div></div></body></html>'

test('dispatch: capture down from the window, target, bubble up; stopPropagation; once; passive', async () => {
  const web = createWeb()
  await web.internals.loadPage(PAGE)
  const order = web.json<string[]>(`(() => {
    const log = []
    const leaf = document.getElementById('leaf'), inner = document.getElementById('inner'), outer = document.getElementById('outer')
    const at = (name) => (e) => log.push(name + ':' + e.eventPhase + ':' + (e.currentTarget === window ? 'window' : e.currentTarget.id || e.currentTarget.nodeName))
    window.addEventListener('ping', at('w-capture'), true)
    window.addEventListener('ping', at('w-bubble'))
    document.addEventListener('ping', at('d-capture'), { capture: true })
    outer.addEventListener('ping', at('o-capture'), true)
    outer.addEventListener('ping', at('o-bubble'))
    leaf.addEventListener('ping', at('t-bubble'))
    leaf.addEventListener('ping', at('t-capture'), true)
    inner.addEventListener('ping', at('i-once'), { once: true })
    leaf.dispatchEvent(new Event('ping', { bubbles: true }))
    leaf.dispatchEvent(new Event('ping', { bubbles: true }))
    return log
  })()`)
  assert.deepEqual(order.slice(0, 9), ['w-capture:1:window', 'd-capture:1:#document', 'o-capture:1:outer', 't-capture:2:leaf', 't-bubble:2:leaf', 'i-once:3:inner', 'o-bubble:3:outer', 'w-bubble:3:window', 'w-capture:1:window'])
  assert.equal(order.filter((e) => e.startsWith('i-once')).length, 1)

  const stopped = web.json(`(() => {
    const log = []
    const leaf = document.getElementById('leaf'), inner = document.getElementById('inner')
    inner.addEventListener('pong', (e) => { log.push('inner'); e.stopPropagation() })
    document.body.addEventListener('pong', () => log.push('body'))
    leaf.addEventListener('pong', (e) => { log.push('a'); e.stopImmediatePropagation() })
    leaf.addEventListener('pong', () => log.push('b'))
    const event = new CustomEvent('pong', { bubbles: true, cancelable: true, detail: 7 })
    leaf.addEventListener('pong', (e) => e.preventDefault(), { passive: true })
    const result = leaf.dispatchEvent(event)
    return { log, result, phase: event.eventPhase, current: event.currentTarget, detail: event.detail, path: event.composedPath().length }
  })()`)
  assert.deepEqual(stopped, { log: ['a'], result: true, phase: 0, current: null, detail: 7, path: 0 })
  web.close()
})

test('composedPath, window.event, inline handlers from markup and properties, errors reported', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><div id="d" onclick="window.clicked = (window.clicked || 0) + 1; return false"><b id="b">x</b></div></body></html>')
  const result = web.json(`(() => {
    const b = document.getElementById('b')
    let path, current
    document.body.addEventListener('click', (e) => { path = e.composedPath().map((t) => t === window ? 'window' : t.nodeName); current = window.event === e })
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    const notCancelled = b.dispatchEvent(ev)
    const d = document.getElementById('d')
    const fromAttr = typeof d.onclick
    d.onclick = null
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { path, current, clicked: window.clicked, notCancelled, fromAttr, after: window.event === undefined }
  })()`)
  assert.deepEqual(result, { path: ['B', 'DIV', 'BODY', 'HTML', '#document', 'window'], current: true, clicked: 1, notCancelled: false, fromAttr: 'function', after: true })

  const seen = web.json(`(() => {
    const log = []
    window.addEventListener('error', (e) => log.push('error:' + e.message))
    document.body.addEventListener('boom', () => { throw new Error('bad') })
    document.body.addEventListener('boom', () => log.push('second'))
    document.body.dispatchEvent(new Event('boom'))
    return log
  })()`)
  assert.deepEqual(seen, ['error:bad', 'second'])
  assert.equal(web.host.errors.length, 1)
  web.close()
})

test('click activation: checkbox toggles (undone when cancelled), label clicks its control, submit fires submit', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><form id="f"><label id="l">x <input id="c" type="checkbox"></label><input id="t" name="t" value="v"><button id="s">go</button></form></body></html>')
  const result = web.json(`(() => {
    const log = []
    const c = document.getElementById('c'), f = document.getElementById('f')
    c.addEventListener('change', () => log.push('change ' + c.checked))
    c.addEventListener('input', () => log.push('input'))
    c.click()
    const afterClick = c.checked
    c.addEventListener('click', (e) => e.preventDefault(), { once: true })
    c.click()
    const afterCancelled = c.checked
    document.getElementById('l').click()
    const afterLabel = c.checked
    f.addEventListener('submit', (e) => { e.preventDefault(); log.push('submit ' + (e.submitter && e.submitter.id) + ' ' + new FormData(f).get('t')) })
    document.getElementById('s').click()
    return { log, afterClick, afterCancelled, afterLabel }
  })()`)
  assert.deepEqual(result, { log: ['input', 'change true', 'input', 'change false', 'submit s v'], afterClick: true, afterCancelled: true, afterLabel: false })
  web.close()
})

test('hover: a removed target hands its boundary to the nearest connected ancestor', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><nav id="dock"><span id="ico"><b id="art">x</b></span></nav><div id="away"></div></body></html>')
  const id = (name: string) => web.internals.idOf(web.run(`document.getElementById("${name}")`))
  web.dom.boxes.set(id('dock'), { x: 0, y: 0, width: 200, height: 100 })
  web.dom.boxes.set(id('ico'), { x: 10, y: 10, width: 50, height: 50 })
  web.dom.boxes.set(id('art'), { x: 10, y: 10, width: 50, height: 50 })
  web.dom.boxes.set(id('away'), { x: 0, y: 300, width: 200, height: 100 })
  web.run(`
    globalThis.log = []
    for (const type of ['mouseover', 'mouseout', 'mouseenter', 'mouseleave'])
      document.addEventListener(type, (e) => log.push(type + ':' + (e.target.id || e.target.nodeName)), true)
  `)
  const input = web.internals.input
  input.pointer('pointermove', 20, 20)
  web.run('log.length = 0; document.getElementById("ico").innerHTML = "<b id=art2>y</b>"')
  web.dom.boxes.set(id('art2'), { x: 10, y: 10, width: 50, height: 50 })
  input.pointer('pointermove', 21, 20)
  assert.deepEqual(web.json('log'), ['mouseout:ico', 'mouseover:art2', 'mouseenter:art2'])
  web.run('log.length = 0')
  input.leave()
  assert.deepEqual(web.json('log'), ['mouseout:art2', 'mouseleave:art2', 'mouseleave:ico', 'mouseleave:dock', 'mouseleave:BODY', 'mouseleave:HTML'])
  web.close()
})

test('input routing: hover, compat mouse events, click count, focus on press, keys to the focused element', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><div id="a"><button id="btn">b</button></div><input id="field"></body></html>')
  const a = web.internals.idOf(web.run('document.getElementById("a")'))
  const btn = web.internals.idOf(web.run('document.getElementById("btn")'))
  const field = web.internals.idOf(web.run('document.getElementById("field")'))
  web.dom.boxes.set(a, { x: 0, y: 0, width: 200, height: 100 })
  web.dom.boxes.set(btn, { x: 10, y: 10, width: 50, height: 20 })
  web.dom.boxes.set(field, { x: 0, y: 200, width: 100, height: 20 })
  web.run(`
    globalThis.log = []
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'pointerleave', 'focus', 'keydown', 'keypress', 'keyup'])
      document.addEventListener(type, (e) => log.push(type + ':' + (e.target.id || e.target.nodeName) + (type === 'click' || type === 'mousedown' ? ':' + e.detail : '')), true)
  `)
  const input = web.internals.input
  input.pointer('pointermove', 20, 15)
  input.pointer('pointerdown', 20, 15)
  input.pointer('pointerup', 20, 15)
  input.pointer('pointerdown', 20, 15)
  input.pointer('pointerup', 20, 15)
  const log = web.json<string[]>('log')
  assert.deepEqual(log.slice(0, 2), ['pointerover:btn', 'mouseover:btn'])
  assert.deepEqual(log.filter((e) => e.startsWith('pointerenter')), ['pointerenter:HTML', 'pointerenter:BODY', 'pointerenter:a', 'pointerenter:btn'])
  assert.ok(log.includes('focus:btn'))
  assert.ok(log.includes('click:btn:1') && log.includes('click:btn:2') && log.includes('dblclick:btn'))
  assert.ok(log.indexOf('pointerdown:btn') < log.indexOf('mousedown:btn:1'))
  assert.equal(web.run('document.activeElement.id'), 'btn')
  assert.equal(web.dom.focus.id, btn)
  input.pointer('pointerdown', 10, 205)
  input.pointer('pointerup', 10, 205)
  assert.equal(web.run('document.activeElement.id'), 'field')
  web.run('log.length = 0')
  input.key('keydown', 'a', 'KeyA')
  input.key('keyup', 'a', 'KeyA')
  assert.deepEqual(web.json('log'), ['keydown:field', 'keypress:field', 'keyup:field'])
  web.run('document.addEventListener("keydown", (e) => globalThis.lastKey = e.keyCode + e.key, { once: true })')
  input.key('keydown', 'Enter', 'Enter')
  assert.equal(web.run('lastKey'), '13Enter')
  input.key('keydown', 'Tab', 'Tab', { modifiers: { shift: true } })
  assert.equal(web.run('document.activeElement.id'), 'btn')
  assert.equal(web.dom.focus.visible, true)
  web.close()
})
