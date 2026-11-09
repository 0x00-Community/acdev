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

  test('setFrameTheme hands the checked theme to the runtime as numbers', () => {
    const calls: number[][] = []
    const desktop = Frame.desktop({ setFrameTheme: (...args) => void calls.push(args) })
    desktop.setFrameTheme({ active: { background: '#000' }, buttonSide: 'left' })
    desktop.setFrameTheme(null)
    assert.deepEqual(calls, [
      [0x000000ff, -1, -1, -1, -1, -1, -1, -1, 0, 1, 0],
      [-1, -1, -1, -1, -1, -1, -1, -1, 0, 0, 0],
    ])
  })

  test('a bad theme is a TypeError and changes nothing', () => {
    const calls: number[][] = []
    const desktop = Frame.desktop({ setFrameTheme: (...args) => void calls.push(args) })
    assert.throws(() => desktop.setFrameTheme({ active: { background: 'blue' } }), (e: Error) => e instanceof TypeError && /active.background/.test(e.message))
    assert.throws(() => desktop.setFrameTheme({ shadow: true } as never), TypeError)
    assert.deepEqual(calls, [])
  })

  test('an unknown action is a TypeError and changes nothing', () => {
    const calls: string[] = []
    const desktop = Frame.desktop({ setDoubleClick: (action) => void calls.push(action) })
    assert.throws(() => desktop.setDoubleClick('maximize' as never), TypeError)
    assert.throws(() => desktop.setDoubleClick(undefined as never), TypeError)
    assert.deepEqual(calls, [])
  })
})
