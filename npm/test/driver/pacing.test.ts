import { describe, expect, test } from 'bun:test'
import type { InputEvent } from '../../src/driver/input.ts'
import { FRAME_MS, HOLD_MS, paced } from '../../src/driver/pacing/index.ts'

describe('input pacing', () => {
  test('a drag without waits holds after the press and rests a frame before the release', () => {
    const drag: InputEvent[] = [
      { type: 'down', x: 10, y: 5 }, { type: 'move', x: 40, y: 5 }, { type: 'move', x: 80, y: 5 }, { type: 'up', x: 80, y: 5 },
    ]
    expect(paced(drag)).toEqual([
      { type: 'down', x: 10, y: 5 }, { type: 'wait', ms: HOLD_MS }, { type: 'move', x: 40, y: 5 }, { type: 'move', x: 80, y: 5 },
      { type: 'wait', ms: FRAME_MS }, { type: 'up', x: 80, y: 5 },
    ])
  })

  test('waits the script wrote are kept as they are, nothing added on top', () => {
    const drag: InputEvent[] = [
      { type: 'down', x: 10, y: 5 }, { type: 'wait', ms: 40 }, { type: 'move', x: 80, y: 5 }, { type: 'wait', ms: 5 },
      { type: 'up', x: 80, y: 5 },
    ]
    expect(paced(drag)).toEqual(drag)
  })

  test('a click, keys and a hover are sent unchanged', () => {
    const events: InputEvent[] = [
      { type: 'move', x: 3, y: 3 }, { type: 'down', x: 3, y: 3 }, { type: 'up', x: 3, y: 3 },
      { type: 'keydown', key: 'a' }, { type: 'keyup', key: 'a' },
    ]
    expect(paced(events)).toEqual(events)
  })
})
