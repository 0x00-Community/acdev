import { describe, expect, test } from 'bun:test'
import { hitText, point, renders, renderText, wanted, type Hit, type Render } from '../../../src/driver/probe/index.ts'

const gpu = { path: 'gpu', adapter: 'Intel Arc A770', driver: 'mesa 24.2', backend: 'vulkan', software: false } as const

const render = (web: string, window: string, extra: Partial<Render> = {}): Render =>
  ({ web, window, raster: gpu, composedBy: 'host-window', layers: [], ...extra })

describe('acdev render', () => {
  test('asks every page, or the one of --web, and keeps the page of --window', async () => {
    const asked: string[] = []
    const acde = {
      webList: async () => ({ webs: [{ name: 'desktop' }, { name: 'notes#1' }] }),
      render: async (web: string) => {
        asked.push(web)
        return render(web, web === 'desktop' ? 'w0' : 'w2')
      },
    }
    expect((await renders(acde, {})).map((r) => r.web)).toEqual(['desktop', 'notes#1'])
    expect((await renders(acde, wanted(new Map([['window', 'w2']])))).map((r) => r.web)).toEqual(['notes#1'])
    expect((await renders(acde, wanted(new Map([['web', 'desktop']])))).map((r) => r.web)).toEqual(['desktop'])
    expect(asked).toEqual(['desktop', 'notes#1', 'desktop', 'notes#1', 'desktop'])
    await expect(renders(acde, { window: 'w9' })).rejects.toThrow('no page shows window w9')
  })

  test('prints the raster, who composes the glass, and a row per layer with why it is degraded', () => {
    const layers = [
      { rect: [10.4, 52, 100, 50], kind: 'glass', group: 'g0', pieces: 3, element: 'w2.30', drawn: 'cpu-glass-frosted', degraded: 'cpu-cannot-refract' },
      { panel: 4, rect: [0, 0, 20, 20], kind: 'frost', drawn: 'frost' },
    ] as const
    const text = renderText([render('notes#1', 'w2', { raster: { path: 'cpu', canvases: null, degraded: 'no-gpu' }, layers })])
    expect(text.split('\n')).toEqual([
      'w2 notes#1: raster cpu, degraded: no-gpu; the host window composes the glass',
      '  window   element  kind   group   rect          page               compositor  degraded',
      '  w2       w2.30    glass  g0 (3)  10,52,100,50  cpu-glass-frosted  -           cpu-cannot-refract',
      '  panel 4  -        frost  -       0,0,20,20     frost              -           -',
    ])
    expect(renderText([render('desktop', 'w0')])).toBe(
      'w0 desktop: raster gpu (Intel Arc A770, vulkan, mesa 24.2); the host window composes the glass\n  (no layer with a backdrop-filter)',
    )
  })
})

describe('acdev hit', () => {
  test('takes two numbers', () => {
    expect(point(['640', '360'])).toEqual({ x: 640, y: 360 })
    expect(() => point(['a', '1'])).toThrow('x and y are numbers')
  })

  test('prints the window, its part, the element with its parents and what the point passed through', () => {
    const element = (ref: string, line: string) => ({ ref, line, tag: 'div' })
    const hit: Hit = {
      x: 150, y: 140, window: { ref: 'w2', app: 'notes', title: 'Notes' }, surface: 'page', local: [50, 40],
      element: {
        ...element('w2.12', 'button "Save" [w2.12]'),
        chain: ['a', 'b', 'c', 'd', 'e'].map((name, i) => element(`w2.${i}`, `generic "${name}" [w2.${i}]`)),
        through: [element('w2.20', 'generic "veil" [w2.20]')],
      },
    }
    expect(hitText(hit).split('\n')).toEqual([
      '150,140: w2 (Notes) page at 50,40',
      '  button "Save" [w2.12] < generic "a" [w2.0] < generic "b" [w2.1] < generic "c" [w2.2] < generic "d" [w2.3] < … 1 more',
      '  passed through (pointer-events: none): generic "veil" [w2.20]',
    ])
    expect(hitText({ x: 1, y: 2, window: null, surface: 'none' })).toBe('1,2: no window there')
    expect(hitText({ x: 5, y: 5, window: { ref: 'w2', app: 'notes', title: null }, surface: 'decoration', local: [5, 5] })).toBe(
      '5,5: w2 (notes) title bar at 5,5',
    )
    expect(hitText({ x: 5, y: 50, window: { ref: 'w2', app: 'notes', title: 'Notes' }, surface: 'page', gone: true })).toBe(
      '5,50: w2 (Notes) page: the page went away before it answered; ask again',
    )
  })
})
