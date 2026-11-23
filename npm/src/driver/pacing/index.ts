import type { InputEvent } from '../input.ts'

export const HOLD_MS = 150
export const FRAME_MS = 16

export function paced(events: readonly InputEvent[]): InputEvent[] {
  const out: InputEvent[] = []
  events.forEach((event, at) => {
    const before = events[at - 1]
    if (event.type === 'move' && before?.type === 'down') out.push({ type: 'wait', ms: HOLD_MS })
    if (event.type === 'up' && before?.type === 'move') out.push({ type: 'wait', ms: FRAME_MS })
    out.push(event)
  })
  return out
}
