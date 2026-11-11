import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { WebInit } from '../src/broker/types.ts'
import { RemoteBridge, WindowList, WindowSelf } from '../src/remote.ts'
import { Rpc } from '../src/rpc.ts'

const output = WindowSelf.output(800, 600, 1)
const self = (surface: object) => new WindowSelf(null as never, surface as never, {} as never, null, output)

describe('WindowSelf.hostControls', () => {
  test('follows what the runtime says about the window', () => {
    assert.equal(self({ window: 7, hostControls: true }).hostControls, true)
    assert.equal(self({ window: 7, hostControls: false }).hostControls, false)
    assert.equal(self({ window: 7 }).hostControls, false)
  })

  test('has a change event', () => {
    const window = self({ window: 7, hostControls: true })
    const seen: unknown[] = []
    const off = window.api.on('hostcontrols', (value) => void seen.push(value))
    window.emit('hostcontrols', false)
    off()
    window.emit('hostcontrols', true)
    assert.deepEqual(seen, [false])
  })
})

describe('WindowSelf.minimizable', () => {
  test('follows the runtime and defaults to true', () => {
    assert.equal(self({ window: 7, minimizable: false }).minimizable, false)
    assert.equal(self({ window: 7, minimizable: true }).minimizable, true)
    assert.equal(self({ window: 7 }).minimizable, true)
  })
})

describe('acde:window on()', () => {
  const NAMES = 'activate, deactivate, beforeclose, request, suspend, resume, grab, grablost, state, output, hostcontrols, minimizable, shortcut'
  const module = () => {
    const rpc = new Rpc(() => {})
    const window = self({ window: 7 })
    const init = { kind: 'window', name: 'notes#7', services: {}, app: { id: 'notes', label: 'Notes', capabilities: {} }, tier: { level: 1, shell: [], refused: {} } }
    const bridge = new RemoteBridge(rpc, init as unknown as WebInit, window, new WindowList(rpc))
    return bridge.value['window'] as { on(name: string, handler: () => void): () => boolean }
  }

  test('an event type the window does not have is a TypeError that lists the ones it has', () => {
    const window = module()
    for (const name of ['nosuch', 'close', 'toString', '']) {
      assert.throws(() => window.on(name, () => {}), (e: Error) => e instanceof TypeError && e.message === `acde:window has no ${name} event (${NAMES})`, name)
    }
    assert.throws(() => self({ window: 7 }).api.on('nosuch' as never, () => {}), TypeError)
  })

  test('every event type the SDK lists can be subscribed to and unsubscribed from', () => {
    const window = module()
    for (const name of NAMES.split(', ')) {
      const off = window.on(name, () => {})
      assert.equal(off(), true, name)
    }
  })
})
