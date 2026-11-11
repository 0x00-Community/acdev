import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DevRequests } from '../../src/broker/dev.ts'
import type { NativeDevToolsTarget } from '../../src/native.ts'

const desktop = { name: 'desktop', kind: 'desktop', app: null, url: null, window: 0 }
const ledger = { name: 'ledger#7', kind: 'window', app: { id: 'ledger' }, url: 'http://acde.local/', window: 7 }

function session(webs: object[], services: string[]) {
  const pushed: NativeDevToolsTarget[][] = []
  const devtools = { open: () => ({ port: 1, token: 't' }), targets: (list: NativeDevToolsTarget[]) => void pushed.push(list) }
  const titles: Record<string, string> = { desktop: 'Dopame', 'ledger#7': 'Ledger' }
  const host = { devtools, webs: () => webs, services: () => services, title: (web: { name: string }) => titles[web.name]! }
  return { dev: new DevRequests(host as never), pushed, webs, services }
}

test('the desktop, each window and the services are targets with readable titles', () => {
  const { dev, pushed } = session([desktop, ledger], ['assistant', 'store'])
  dev.publish()
  assert.deepEqual(pushed.at(-1), [
    { id: 'desktop', kind: 'page', title: 'Dopame (desktop)', url: 'http://acde.local/' },
    { id: 'ledger#7', kind: 'page', title: 'Ledger (ledger)', url: 'http://acde.local/' },
    { id: 'broker', kind: 'service', title: 'services: assistant, store', url: '' },
  ])
})

test('the list follows windows and services and is pushed only when it changes', () => {
  const { dev, pushed, webs, services } = session([desktop], [])
  dev.publish()
  dev.publish()
  assert.equal(pushed.length, 1)
  assert.deepEqual(pushed[0]!.map((t) => t.id), ['desktop'])
  webs.push(ledger)
  services.push('assistant')
  dev.publish()
  assert.deepEqual(pushed.at(-1)!.map((t) => t.id), ['desktop', 'ledger#7', 'broker'])
  webs.pop()
  dev.publish()
  assert.deepEqual(pushed.at(-1)!.map((t) => t.id), ['desktop', 'broker'])
})
