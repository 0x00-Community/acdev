import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Frame } from '../src/frame.ts'

describe('Frame.desktop', () => {
  test('setDoubleClick hands each declared action to the runtime', () => {
    const calls: string[] = []
    const desktop = Frame.desktop({ setDoubleClick: (action) => void calls.push(action) })
    desktop.setDoubleClick('minimize')
    desktop.setDoubleClick('none')
    desktop.setDoubleClick('fill')
    assert.deepEqual(calls, ['minimize', 'none', 'fill'])
  })

  test('an unknown action is a TypeError and changes nothing', () => {
    const calls: string[] = []
    const desktop = Frame.desktop({ setDoubleClick: (action) => void calls.push(action) })
    assert.throws(() => desktop.setDoubleClick('maximize' as never), TypeError)
    assert.throws(() => desktop.setDoubleClick(undefined as never), TypeError)
    assert.deepEqual(calls, [])
  })
})
