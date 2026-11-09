import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WindowCalls } from '../src/broker/calls/windows.ts'

const calls = (minimize: boolean) => {
  const states: string[] = []
  const host = {
    shell: { setState: (_: number, state: string) => void states.push(state), windows: () => [{ id: 9, minimize }] },
    record: (id: number) => (id === 9 ? { id: 9, app: { id: 'app' } } : undefined),
  }
  return { windows: new WindowCalls(host as never), states, web: { kind: 'window', window: 9 } as never }
}

test('a window that cannot minimize refuses with a typed error', () => {
  const { windows, states, web } = calls(false)
  assert.throws(() => windows.self(web, 'minimize', []), (e: Error & { code?: string; status?: number }) => e.code === 'unavailable' && e.status === 409)
  assert.deepEqual(states, [])
})

test('other windows minimize as before', () => {
  const { windows, states, web } = calls(true)
  windows.self(web, 'minimize', [])
  assert.deepEqual(states, ['minimized'])
})
