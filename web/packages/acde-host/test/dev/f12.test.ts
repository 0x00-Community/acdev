import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRequests } from '../../src/broker/dev.ts'
import { bindNatives } from '../../src/sys/natives.ts'

const logged: string[] = []
bindNatives({ host: { log: (_: number, __: string, text: string) => void logged.push(text) } as never, sys: {} as never })

const ledger = { name: 'ledger#7', kind: 'window', app: { id: 'ledger' }, url: 'http://acde.local/', window: 7 }
const desktop = { name: 'desktop', kind: 'desktop', app: null, url: null, window: 0 }

function session(reached: number) {
  const sent: unknown[] = []
  const shell = { devEvent: (message: string) => (sent.push(JSON.parse(message)), reached) }
  const host = { shell, devtools: null, webs: () => [desktop, ledger], services: () => [], title: () => '' }
  return { dev: new DevRequests(host as never), sent }
}

test('F12 sends one devtools event naming the page by its target id', () => {
  const { dev, sent } = session(1)
  dev.devtools(ledger as never)
  assert.deepEqual(sent, [{ type: 'event', event: 'devtools', web: 'ledger#7', app: 'ledger', window: 7 }])
})

test('the desktop page is named desktop and has no app', () => {
  const { dev, sent } = session(1)
  dev.devtools(desktop as never)
  assert.deepEqual(sent, [{ type: 'event', event: 'devtools', web: 'desktop', app: null, window: 0 }])
})

test('no page sends nothing, and no acde dev to hear it does not throw', () => {
  const { dev, sent } = session(0)
  logged.length = 0
  dev.devtools(null)
  assert.deepEqual(sent, [])
  dev.devtools(ledger as never)
  assert.equal(sent.length, 1)
  assert.deepEqual(logged, [
    'acde dev: F12: no page has the focus',
    'acde dev: F12 on ledger#7: no acde dev is connected to open DevTools',
  ])
})
