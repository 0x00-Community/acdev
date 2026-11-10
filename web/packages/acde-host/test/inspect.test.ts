import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Inspect } from '../src/inspect.ts'

const session = (rows: Record<string, unknown>[]) => {
  const done: string[] = []
  const inspect = new Inspect({
    shell: {
      windows: () => rows.map((row) => ({ x: 0, y: 0, width: 800, height: 600, z: 1, focus: true, ...row })),
      setState: (id: number, state: string) => {
        done.push(`state ${id} ${state}`)
        const row = rows.find((r) => r['id'] === id)
        if (row && row['minimize'] !== false) row['state'] = state
      },
      focus: (id: number) => void done.push(`focus ${id}`),
    } as never,
    web: () => null,
    record: (id) => (id === 0 ? null : { kind: 'web', app: 'solo', title: 'Solo' }),
    panel: () => false,
    close: async () => undefined,
    hide: (id, hidden) => void done.push(`${hidden ? 'hide' : 'show'} ${id}`),
    open: async () => '',
    accessibility: async () => null,
    records: () => rows.map((row) => Number(row['id'])).filter((id) => id !== 0),
  })
  return { inspect, done }
}

test('act minimize says no for a window the runtime would not minimize, and does nothing', async () => {
  const { inspect, done } = session([{ id: 1048576, mode: 'fullscreen', state: 'normal', minimize: false }])
  const result = await inspect.api.act('w1', 'minimize')
  assert.equal(result.ok, false)
  assert.match(result.text, /^w1 cannot be minimized: it fills the host window, which only the host window's own controls minimize here/)
  assert.deepEqual(done, [])
})

test('act minimize minimizes a window that can be, and says so', async () => {
  const { inspect, done } = session([{ id: 0, mode: 'fullscreen', minimize: false }, { id: 1048576, mode: 'free', state: 'normal', minimize: true }])
  const result = await inspect.api.act('w1', 'minimize')
  assert.equal(result.ok, true)
  assert.match(result.text, /^w1 is minimized/)
  assert.deepEqual(done, ['state 1048576 minimized'])
  const desktop = await inspect.api.act('w0', 'minimize')
  assert.equal(desktop.ok, false)
  assert.match(desktop.text, /^the desktop cannot be minimized/)
})
