import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { WindowSelf } from '../src/remote.ts'

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
