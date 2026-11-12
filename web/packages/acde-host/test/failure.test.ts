import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Failure } from '../src/failure.ts'

test('a failed start is one line without the Error prefix; ACDE_DEBUG keeps the stack', () => {
  const error = new Error('no desktop nope: not installed')
  assert.equal(Failure.line(error, false), 'acde: no desktop nope: not installed\n')
  const debug = Failure.line(error, true)
  assert.ok(debug.startsWith('acde: Error: no desktop nope: not installed\n'), debug)
  assert.ok(debug.split('\n').length > 2, 'the stack follows')
  assert.equal(Failure.line('plain text', false), 'acde: plain text\n')
  assert.equal(Failure.line('plain text', true), 'acde: plain text\n')
})
