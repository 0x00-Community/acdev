import { describe, expect, test } from 'bun:test'
import type { InspectWindow } from '@acde/api'
import * as GuestPlace from '../../src/driver/place/index.ts'

const WINDOW: InspectWindow = {
  ref: 'w1', id: 7, kind: 'web', app: 'notes', title: 'Notes', mode: 'normal', state: 'normal',
  rect: [40, 30, 640, 480], z: 1, focus: true, hidden: false, pid: 12,
} as InspectWindow

describe('GuestPlace', () => {
  test('a point is x,y and a size is WxH with both sides above 0', () => {
    expect(GuestPlace.point('100,80')).toEqual({ x: 100, y: 80 })
    expect(GuestPlace.point(' -5 , 2.5 ')).toEqual({ x: -5, y: 2.5 })
    expect(GuestPlace.point('100')).toBeNull()
    expect(GuestPlace.point(undefined)).toBeNull()
    expect(GuestPlace.size('800x600')).toEqual({ width: 800, height: 600 })
    expect(GuestPlace.size('800X600')).toEqual({ width: 800, height: 600 })
    expect(GuestPlace.size('0x600')).toBeNull()
    expect(GuestPlace.size('800,600')).toBeNull()
  })

  test('move places at the point, resize keeps the place, raise focuses', () => {
    expect(GuestPlace.change(WINDOW, 'move', '100,80')).toEqual({ place: { x: 100, y: 80 } })
    expect(GuestPlace.change(WINDOW, 'resize', '800x600')).toEqual({ place: { x: 40, y: 30, width: 800, height: 600 } })
    expect(GuestPlace.change(WINDOW, 'raise', undefined)).toEqual({ focus: true })
  })

  test('refusals say why: a bad argument, the desktop, a minimized window', () => {
    expect(GuestPlace.change(WINDOW, 'move', 'left')).toBe('move needs where to: screen x,y like "100,80", not "left"')
    expect(GuestPlace.change(WINDOW, 'resize', undefined)).toBe('resize needs a size: WxH like "800x600", not null')
    const desktop = { ...WINDOW, ref: 'w0', kind: 'desktop' } as InspectWindow
    expect(GuestPlace.change(desktop, 'move', '1,1')).toBe('the desktop cannot move')
    expect(GuestPlace.change(desktop, 'raise', undefined)).toBe('the desktop stays behind every window; it cannot be raised')
    const hidden = { ...WINDOW, hidden: true } as InspectWindow
    expect(GuestPlace.change(hidden, 'raise', undefined)).toBe('w1 is minimized; act w1 restore first')
    const said = GuestPlace.refused(WINDOW, new Error('window 7 is filled, not normal'))
    expect(said).toEqual({ ok: false, text: 'window 7 is filled, not normal; act w1 restore first' })
  })

  test('the answer reads back the rect and says when the app has not taken the size', () => {
    const rect = GuestPlace.rect({ x: 100, y: 80, width: 640, height: 480 })
    expect(rect).toEqual([100, 80, 640, 480])
    expect(GuestPlace.rect({ x: 1 })).toBeNull()
    expect(GuestPlace.said(WINDOW, rect!, { x: 100, y: 80 }).text).toBe('w1 is at 100,80 640x480')
    expect(GuestPlace.said(WINDOW, rect!, { x: 100, y: 80, width: 800, height: 600 }).text)
      .toBe('w1 is at 100,80 640x480; the app has not taken the size 800x600 yet')
  })
})

describe('GuestPlace.settle', () => {
  test('reads the rect again until the app takes the size', async () => {
    const seen: (readonly [number, number, number, number])[] = [[100, 80, 700, 500], [100, 80, 800, 600]]
    const read = () => Promise.resolve(seen.shift())
    const rect = await GuestPlace.settle([100, 80, 640, 480], { x: 100, y: 80, width: 800, height: 600 }, read)
    expect(rect).toEqual([100, 80, 800, 600])
    expect(seen).toEqual([])
  })
})
