import assert from 'node:assert/strict'
import { test } from 'node:test'
import { page } from './harness.ts'
import { MockStorage } from './mock/storage.ts'

test('localStorage: named properties follow WebIDL (methods win, assignments store, delete removes)', async () => {
  const storage = new MockStorage({ key: 'stored key', a: '1' })
  using web = await page(undefined, { storage })
  const out = web.json(`(() => {
    const out = {}
    out.methodWins = [typeof localStorage.key, localStorage.getItem('key'), 'key' in localStorage, localStorage.a]
    localStorage.b = 2
    localStorage.key = 'again'
    out.assigned = [localStorage.getItem('b'), localStorage.getItem('key'), typeof localStorage.key]
    out.keys = Object.keys(localStorage)
    out.forIn = []
    for (const k in localStorage) if (Object.hasOwn(localStorage, k)) out.forIn.push(k)
    out.descriptor = Object.getOwnPropertyDescriptor(localStorage, 'a')
    out.noDescriptorForMethod = Object.getOwnPropertyDescriptor(localStorage, 'key') === undefined
    delete localStorage.a
    delete localStorage.key
    out.deleted = [localStorage.getItem('a'), localStorage.getItem('key'), localStorage.length]
    Object.defineProperty(localStorage, 'c', { value: 3 })
    out.defined = localStorage.getItem('c')
    try { Object.defineProperty(localStorage, 'd', { get() { return 1 } }); out.accessor = 'defined' } catch (e) { out.accessor = e.constructor.name }
    out.json = JSON.stringify(localStorage)
    out.brand = [localStorage instanceof Storage, Object.prototype.toString.call(localStorage), sessionStorage instanceof Storage]
    try { new Storage(); out.ctor = 'made' } catch (e) { out.ctor = e.constructor.name }
    try { localStorage.getItem(); out.noArg = 'ok' } catch (e) { out.noArg = e.constructor.name }
    try { localStorage.getItem(Symbol('s')); out.symbol = 'ok' } catch (e) { out.symbol = e.constructor.name }
    out.keyIndex = [localStorage.key(0), localStorage.key(99), localStorage.key(-4294967296)]
    return out
  })()`)
  assert.deepEqual(out, {
    methodWins: ['function', 'stored key', true, '1'],
    assigned: ['2', 'again', 'function'],
    keys: ['a', 'b'],
    forIn: ['a', 'b'],
    descriptor: { value: '1', writable: true, enumerable: true, configurable: true },
    noDescriptorForMethod: true,
    deleted: [null, 'again', 2],
    defined: '3',
    accessor: 'TypeError',
    json: '{"b":"2","c":"3"}',
    brand: [true, '[object Storage]', true],
    ctor: 'TypeError',
    noArg: 'TypeError',
    symbol: 'TypeError',
    keyIndex: ['key', null, 'key'],
  })
})

test('localStorage: writes carry the page URL; a full area throws QuotaExceededError and keeps the old value', async () => {
  const storage = new MockStorage()
  using web = await page(undefined, { storage, url: 'http://acde.local/notes.html' })
  storage.quota = 8
  const out = web.json(`(() => {
    localStorage.setItem('k', 'small')
    try { localStorage.setItem('k', 'much too long'); return 'stored' } catch (e) { return [e.name, e.code, e instanceof DOMException, localStorage.getItem('k')] }
  })()`)
  assert.deepEqual(out, ['QuotaExceededError', 22, true, 'small'])
  assert.deepEqual(storage.writes, [['k', 'small', 'http://acde.local/notes.html']])
})

test('sessionStorage: its own area with the 5 MiB quota', async () => {
  using web = await page(undefined, { storage: new MockStorage() })
  const out = web.json(`(() => {
    sessionStorage.setItem('s', '1')
    const separate = [localStorage.getItem('s'), sessionStorage.getItem('s')]
    try { sessionStorage.setItem('big', 'x'.repeat(5 * 1024 * 1024)); return 'stored' } catch (e) { return [...separate, e.name, sessionStorage.length] }
  })()`)
  assert.deepEqual(out, [null, '1', 'QuotaExceededError', 1])
})

test('storage events: changes from another window fire at window with the standard fields', async () => {
  const storage = new MockStorage({ theme: 'dark' })
  using web = await page(undefined, { storage })
  web.run(`globalThis.heard = []
    addEventListener('storage', (e) => heard.push([e.constructor.name, e.type, e.key, e.oldValue, e.newValue, e.url, e.storageArea === localStorage, e.bubbles, e.cancelable]))
    onstorage = (e) => heard.push('handler ' + e.key)
    localStorage.setItem('own', 'change')`)
  storage.fromElsewhere('theme', 'light')
  storage.fromElsewhere('theme', null)
  storage.fromElsewhere(null, null)
  assert.deepEqual(web.json('heard'), [
    ['StorageEvent', 'storage', 'theme', 'dark', 'light', 'http://acde.local/other', true, false, false],
    'handler theme',
    ['StorageEvent', 'storage', 'theme', 'light', null, 'http://acde.local/other', true, false, false],
    'handler theme',
    ['StorageEvent', 'storage', null, null, null, 'http://acde.local/other', true, false, false],
    'handler null',
  ])
  assert.equal(web.run('localStorage.length'), 0)
})

test('without a native area localStorage still works, in memory', async () => {
  using web = await page()
  assert.deepEqual(web.json(`(() => { localStorage.setItem('a', 'b'); return [localStorage.getItem('a'), localStorage.length] })()`), ['b', 1])
})
