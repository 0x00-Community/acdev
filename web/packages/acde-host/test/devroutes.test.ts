import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DevRoutes, type DevRoute } from '../src/devroutes.ts'
import { SourceMaps } from '../src/devlog.ts'

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
