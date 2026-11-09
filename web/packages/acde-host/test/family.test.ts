import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Family, type FamilyCaller, type FamilyWindow } from '../src/broker/access/family.ts'

const windows = new Map<number, FamilyWindow>([
  [7, { kind: 'web', appId: 'notes' }],
  [8, { kind: 'web', appId: 'mail' }],
  [9, { kind: 'native', appId: null }],
])
const find = (id: number) => windows.get(id)
const notes: FamilyCaller = { desktop: false, appId: 'notes', label: 'Notes' }
const desktop: FamilyCaller = { desktop: true, appId: null, label: 'desktop' }
const fails = (fn: () => unknown, status: number, text: RegExp) =>
  assert.throws(fn, (e: Error & { status?: number }) => e.status === status && text.test(e.message))

describe('Family.of', () => {
  test('no parent means no family; modal alone is ignored', () => {
    assert.equal(Family.of(undefined, notes, find), null)
    assert.equal(Family.of(null, notes, find), null)
    assert.equal(Family.of({ modal: true }, notes, find), null)
  })

  test('an app names its own window as parent, modal or not', () => {
    assert.deepEqual(Family.of({ parent: 7 }, notes, find), { parent: 7, modal: false })
    assert.deepEqual(Family.of({ parent: 7, modal: true }, notes, find), { parent: 7, modal: true })
  })

  test('an app may not parent to another app or a native window', () => {
    fails(() => Family.of({ parent: 8 }, notes, find), 403, /window 8 is not a window of Notes/)
    fails(() => Family.of({ parent: 9, modal: true }, notes, find), 403, /window 9 is not a window of Notes/)
  })

  test('the desktop may name any open window', () => {
    assert.deepEqual(Family.of({ parent: 8, modal: true }, desktop, find), { parent: 8, modal: true })
    assert.deepEqual(Family.of({ parent: 9 }, desktop, find), { parent: 9, modal: false })
  })

  test('a missing or malformed parent fails', () => {
    fails(() => Family.of({ parent: 99 }, desktop, find), 404, /no window 99/)
    fails(() => Family.of({ parent: -1 }, notes, find), 400, /parent is a window id/)
    fails(() => Family.of({ parent: '7' }, notes, find), 400, /parent is a window id/)
    fails(() => Family.of('7', notes, find), 400, /options is an object/)
  })
})
