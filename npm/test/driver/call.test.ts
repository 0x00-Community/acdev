import { describe, expect, test } from 'bun:test'
import * as Call from '../../src/driver/call/index.ts'
import { RequestError } from '../../src/ipc.ts'

describe('call', () => {
  test('a target is manager or desktop', () => {
    expect(Call.target('manager')).toBe('manager')
    expect(Call.target('desktop')).toBe('desktop')
    expect(() => Call.target('shell')).toThrow('call: shell is not a target (manager or desktop) (acdev call --help)')
  })

  test('parameters are JSON, and none when left out or empty', () => {
    expect(Call.params('{"accent":"#d0249f"}')).toEqual({ accent: '#d0249f' })
    expect(Call.params('[1, 2]')).toEqual([1, 2])
    expect(Call.params(undefined)).toBeUndefined()
    expect(Call.params('  \n')).toBeUndefined()
    expect(() => Call.params('{accent')).toThrow('call: the parameters are not JSON: ')
  })

  test('an error says the call and keeps the code it came with', () => {
    const coded = RequestError.of({ type: 'response', ok: false, error: 'refused on the debug connection', code: 'forbidden' })
    expect(Call.failed('desktop', 'secrets.get', coded).message)
      .toBe('call desktop secrets.get: refused on the debug connection (code forbidden)')
    const plain = RequestError.of({ type: 'response', ok: false, error: 'not on the list' })
    expect(plain.code).toBeNull()
    expect(Call.failed('manager', 'apps.open', plain).message).toBe('call manager apps.open: not on the list')
    expect(RequestError.of({ type: 'response', ok: false }).message).toBe('failed without saying why')
  })
})
