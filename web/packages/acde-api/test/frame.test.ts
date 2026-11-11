import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameThemes } from '../src/validate.ts'

const NONE = Array(16).fill(-1)

test('no theme keeps the runtime look', () => {
  assert.deepEqual(FrameThemes.parse(null), { colors: NONE, style: 0, side: 0, align: 0, ignored: [] })
  assert.deepEqual(FrameThemes.parse({}), { colors: NONE, style: 0, side: 0, align: 0, ignored: [] })
})

test('a full theme becomes RGBA numbers and layout codes', () => {
  const wire = FrameThemes.parse({
    active: { background: '#202228', title: '#EEE', line: 'rgba(255, 255, 255, 0.5)', buttons: '#ff000080' },
    inactive: { background: 'rgb(64, 64, 64)', title: '#9998' },
    light: { active: { background: '#F6F4F9' }, inactive: { title: '#6E6977' } },
    buttonStyle: 'glyphs',
    buttonSide: 'left',
    titleAlign: 'center',
  })
  assert.deepEqual(wire, {
    colors: [
      0x202228ff, 0xeeeeeeff, 0xffffff80, 0xff000080, 0x404040ff, 0x99999988, -1, -1,
      0xf6f4f9ff, -1, -1, -1, -1, 0x6e6977ff, -1, -1,
    ],
    style: 2,
    side: 1,
    align: 1,
    ignored: [],
  })
  const layout = FrameThemes.parse({ buttonStyle: 'dots', buttonSide: 'right', titleAlign: 'start' })
  assert.deepEqual(layout, { colors: NONE, style: 1, side: 2, align: 2, ignored: [] })
})

test('unknown keys are ignored and named, so later optional keys do not break older runtimes', () => {
  const wire = FrameThemes.parse({ colour: {}, active: { border: '#000', title: '#000' }, light: { dim: {} } })
  assert.equal(typeof wire, 'object')
  const { ignored, colors } = wire as { readonly ignored: readonly string[]; readonly colors: readonly number[] }
  assert.deepEqual(ignored, ['colour', 'light.dim', 'active.border'])
  assert.equal(colors[1], 0x000000ff)
})

test('bad colors and values are refused', () => {
  for (const bad of ['red', '#12', '#12345', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 2)', 'rgb(1, 2)', '', 7]) {
    assert.match(String(FrameThemes.parse({ active: { background: bad } })), /active.background/, String(bad))
  }
  assert.match(String(FrameThemes.parse({ light: { active: { background: 'red' } } })), /light.active.background/)
  assert.match(String(FrameThemes.parse({ light: 'day' })), /light is an object/)
  assert.match(String(FrameThemes.parse({ buttonStyle: 'round' })), /buttonStyle/)
  assert.match(String(FrameThemes.parse({ buttonSide: 'top' })), /buttonSide/)
  assert.match(String(FrameThemes.parse({ titleAlign: 'end' })), /titleAlign/)
  assert.match(String(FrameThemes.parse('dark')), /object/)
  assert.match(String(FrameThemes.parse({ active: [] })), /active/)
})
