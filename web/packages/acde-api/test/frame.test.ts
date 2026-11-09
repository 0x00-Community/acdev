import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameThemes } from '../src/validate.ts'

const NONE = [-1, -1, -1, -1, -1, -1, -1, -1]

test('no theme keeps the runtime look', () => {
  assert.deepEqual(FrameThemes.parse(null), { colors: NONE, style: 0, side: 0, align: 0 })
  assert.deepEqual(FrameThemes.parse({}), { colors: NONE, style: 0, side: 0, align: 0 })
})

test('a full theme becomes RGBA numbers and layout codes', () => {
  const wire = FrameThemes.parse({
    active: { background: '#202228', title: '#EEE', line: 'rgba(255, 255, 255, 0.5)', buttons: '#ff000080' },
    inactive: { background: 'rgb(64, 64, 64)', title: '#9998' },
    buttonStyle: 'glyphs',
    buttonSide: 'left',
    titleAlign: 'center',
  })
  assert.deepEqual(wire, {
    colors: [0x202228ff, 0xeeeeeeff, 0xffffff80, 0xff000080, 0x404040ff, 0x99999988, -1, -1],
    style: 2,
    side: 1,
    align: 1,
  })
  assert.deepEqual(FrameThemes.parse({ buttonStyle: 'dots', buttonSide: 'right', titleAlign: 'start' }), { colors: NONE, style: 1, side: 2, align: 2 })
})

test('unknown keys are refused', () => {
  assert.match(String(FrameThemes.parse({ colour: {} })), /unknown key "colour"/)
  assert.match(String(FrameThemes.parse({ active: { border: '#000' } })), /active: unknown key "border"/)
})

test('bad colors and values are refused', () => {
  for (const bad of ['red', '#12', '#12345', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 2)', 'rgb(1, 2)', '', 7]) {
    assert.match(String(FrameThemes.parse({ active: { background: bad } })), /active.background/, String(bad))
  }
  assert.match(String(FrameThemes.parse({ buttonStyle: 'round' })), /buttonStyle/)
  assert.match(String(FrameThemes.parse({ buttonSide: 'top' })), /buttonSide/)
  assert.match(String(FrameThemes.parse({ titleAlign: 'end' })), /titleAlign/)
  assert.match(String(FrameThemes.parse('dark')), /object/)
  assert.match(String(FrameThemes.parse({ active: [] })), /active/)
})
