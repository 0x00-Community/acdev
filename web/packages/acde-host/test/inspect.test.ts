import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Inspect } from '../src/inspect.ts'

const TREE = { hidden: 0, truncated: false, width: 800, height: 600, nodes: [{ id: 10, role: 'button', name: 'Save', rect: [10, 10, 80, 20] }] }

const session = (rows: Record<string, unknown>[], states: Record<number, string> = {}) => {
  const done: string[] = []
  const shown = (id: number, hidden: boolean) => {
    done.push(`${hidden ? 'hide' : 'show'} ${id}`)
    const row = rows.find((r) => r['id'] === id)
    if (row) row['hidden'] = hidden
  }
  const page = {
    call: async (_module: string, method: string) => {
      if (method === 'tree') return TREE
      if (method === 'query') return { count: 1, nodes: [{ id: 10, role: 'button', name: 'Save', rect: [10, 10, 80, 20], tag: 'button', visible: true }] }
      if (method === 'point') {
        done.push('measure')
        return { x: 50, y: 20 }
      }
      return undefined
    },
  }
  const inspect = new Inspect({
    shell: {
      windows: () => rows.map((row) => ({ x: 0, y: 0, width: 800, height: 600, z: 1, focus: true, ...row })),
      setState: (id: number, state: string) => {
        done.push(`state ${id} ${state}`)
        const row = rows.find((r) => r['id'] === id)
        if (row && row['minimize'] !== false) row['state'] = state
      },
      focus: (id: number) => {
        done.push(`focus ${id}`)
        const row = rows.find((r) => r['id'] === id)
        if (row?.['state'] === 'minimized') row['state'] = 'normal'
      },
      inject: (event: { type: string }) => void done.push(`inject ${event.type}`),
    } as never,
    web: () => page as never,
    record: (id) => (id === 0 ? null : { kind: 'web', app: 'solo', title: 'Solo', ...(states[id] && { state: states[id] as never }) }),
    panel: () => false,
    close: async () => undefined,
    hide: shown,
    open: async () => '',
    accessibility: async () => null,
    records: () => rows.map((row) => Number(row['id'])).filter((id) => id !== 0),
  })
  return { inspect, done }
}

const DESKTOP = { id: 0, mode: 'fullscreen', minimize: false, focus: false, width: 1440, height: 900 }
const [A, B] = [1048576, 1048577]

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
  assert.match(result.text, /\n- window "Solo" .*\[minimized\] \[w1\]$/)
  assert.deepEqual(done, ['state 1048576 minimized'])
  const desktop = await inspect.api.act('w0', 'minimize')
  assert.equal(desktop.ok, false)
  assert.match(desktop.text, /^the desktop cannot be minimized/)
})

test('a window off the screen is marked minimized, whether its state says so or it was hidden', async () => {
  const rows: Record<string, unknown>[] = [DESKTOP, { id: A, mode: 'free', state: 'minimized', z: 3, focus: false }, { id: B, mode: 'free', state: 'normal', hidden: true, z: 2, focus: false }]
  const { inspect } = session(rows)
  const { text, windows } = await inspect.api.snapshot({ tree: false })
  assert.equal(text, ['- window "Solo" [app=solo] [minimized] [w1]', '- window "Solo" [app=solo] [minimized] [w2]', '- desktop [fullscreen] [w0]'].join('\n'))
  assert.deepEqual(windows.map((w) => [w.ref, w.state, w.hidden]), [['w1', 'minimized', true], ['w2', 'normal', true], ['w0', 'normal', false]])
  rows[1]!['state'] = 'filled'
  assert.deepEqual((await inspect.api.snapshot({ tree: false })).windows.map((w) => [w.ref, w.state, w.hidden])[0], ['w1', 'filled', false])
})

test('a row without a state takes the state the Broker recorded for the window', async () => {
  const { inspect } = session([DESKTOP, { id: A, mode: 'free', hidden: true, z: 3, focus: false }, { id: B, mode: 'free', z: 2 }], { [A]: 'minimized', [B]: 'fullscreen' })
  const { windows } = await inspect.api.snapshot({ tree: false })
  assert.deepEqual(windows.map((w) => [w.ref, w.state, w.hidden]), [['w1', 'minimized', true], ['w2', 'fullscreen', false], ['w0', 'normal', false]])
})

test('all and find leave a minimized window out, and asking for it says why it has no elements', async () => {
  const { inspect } = session([DESKTOP, { id: A, mode: 'free', state: 'minimized', z: 3, focus: false }, { id: B, mode: 'free', state: 'normal', z: 2 }])
  const all = await inspect.api.snapshot({ all: true })
  assert.deepEqual(Object.keys(all.trees).sort(), ['w0', 'w2'])
  assert.match(all.text, /^- window "Solo" \[app=solo\] \[minimized\] \[w1\]\n- window "Solo" \[app=solo\] \[focused\] \[w2\]\n  - button "Save" \[w2\.10\]\n/)
  const found = await inspect.api.snapshot({ find: 'save' })
  assert.deepEqual(Object.keys(found.trees).sort(), ['w0', 'w2'])
  const asked = await inspect.api.snapshot({ window: 'w1' })
  assert.deepEqual(asked.trees['w1'], [])
  assert.match(asked.text, /\[minimized\] \[w1\]\n  \(empty\)\n  \(minimized; act restore on it to see its elements\)\n/)
  const focused = await inspect.api.snapshot()
  assert.deepEqual(Object.keys(focused.trees), ['w2'])
})

test('act restore brings back a window minimized by its state, and one that was hidden', async () => {
  for (const [row, calls] of [[{ state: 'minimized' }, ['show', 'focus']], [{ state: 'normal', hidden: true }, ['show', 'focus']]] as const) {
    const { inspect, done } = session([{ ...DESKTOP, focus: true }, { id: A, mode: 'free', z: 3, focus: false, ...row }])
    const result = await inspect.api.act('w1', 'restore')
    assert.equal(result.ok, true)
    assert.match(result.text, /^w1 is in front \(the windows changed\)\n\n- window "Solo" \[app=solo\] \[w1\]\n/)
    assert.deepEqual(done, calls.map((call) => `${call} ${A}`))
    assert.equal((await inspect.api.snapshot({ window: 'w1' })).trees['w1']!.length, 1)
  }
})

test('pointer actions on a minimized window are refused: nothing is measured or injected', async () => {
  const { inspect, done } = session([DESKTOP, { id: A, mode: 'free', state: 'minimized', z: 3, focus: false }, { id: B, mode: 'free', state: 'normal', z: 2 }])
  for (const [ref, action, arg] of [['w1.10', 'click'], ['w1.10', 'hover'], ['w1', 'scroll'], ['w1.10', 'drag', 'w2.10']] as const) {
    const result = await inspect.api.act(ref, action, arg)
    assert.equal(result.ok, false, `${action} ${ref}`)
    assert.match(result.text, /^w1 is minimized; act restore on it first/)
  }
  assert.deepEqual(done, [])
  const dropped = await inspect.api.act('w2.10', 'drag', 'w1.10')
  assert.equal(dropped.ok, false)
  assert.match(dropped.text, /^cannot drop: w1 is minimized; act restore on it first/)
  assert.deepEqual(done, ['measure'])
})

test('a minimized window covers nothing', async () => {
  const { inspect, done } = session([DESKTOP, { id: A, mode: 'free', state: 'minimized', z: 3, focus: false }])
  const result = await inspect.api.act('w0.10', 'click')
  assert.equal(result.ok, true)
  assert.match(result.text, /^clicked 50,20/)
  assert.deepEqual(done, ['measure', 'inject move', 'inject down', 'inject up'])
})

test('query finds the elements of a minimized window and says none of them is visible', async () => {
  const { inspect } = session([DESKTOP, { id: A, mode: 'free', state: 'minimized', z: 3, focus: false }, { id: B, mode: 'free', state: 'normal', z: 2 }])
  const away = await inspect.api.query({ selector: 'button', window: 'w1' })
  assert.deepEqual(away.nodes.map((n) => [n.ref, n.visible]), [['w1.10', false]])
  const shown = await inspect.api.query({ selector: 'button' })
  assert.deepEqual([shown.window, ...shown.nodes.map((n) => n.visible)], ['w2', true])
})
