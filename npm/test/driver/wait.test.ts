import { describe, expect as check, test } from 'bun:test'
import * as Wait from '../../src/driver/wait/index.ts'

function paced() {
  let clock = 0
  const pauses: number[] = []
  const pace: Wait.Pace = {
    now: () => clock,
    pause: async (ms) => {
      clock += ms
      pauses.push(ms)
    },
  }
  return { pace, pauses }
}

const window = (ref: string, app: string, focus: boolean) =>
  ({ ref, id: Number(ref.slice(1)), kind: 'web', app, title: app, mode: 'free', rect: [0, 0, 1, 1], z: 1, focus, hidden: false, pid: 1 }) as never

function scene(overrides: Partial<Wait.WaitScene> = {}): Wait.WaitScene {
  return {
    windows: async () => [],
    snapshot: async () => ({ text: '', windows: [], trees: {} }),
    webs: async () => [],
    query: async () => ({ window: 'w1', count: 0, nodes: [] }),
    evaluate: async () => true,
    network: async () => ({ entries: [], next: 1 }) as never,
    ...overrides,
  }
}

describe('waiting for a condition', () => {
  test('a page that is not there yet is waited for, backing off from 100 to 500 ms; other errors are errors', async () => {
    const { pace, pauses } = paced()
    let asked = 0
    const coming = scene({ evaluate: async () => (++asked < 5 ? Promise.reject(new Error('eval: no page desktop')) : true) })
    const waited = await Wait.waitFor(coming, { kind: 'page', web: 'desktop' }, 5000, pace)
    check(pauses).toEqual([100, 200, 400, 500])
    check(waited.ms).toBe(1200)
    const broken = scene({ evaluate: async () => Promise.reject(new Error('SyntaxError: nope')) })
    check(Wait.waitFor(broken, { kind: 'eval', web: 'desktop', code: ')' }, 5000, pace)).rejects.toThrow('SyntaxError')
  })

  test('a timeout says what was seen last', async () => {
    const { pace } = paced()
    const never = scene({ evaluate: async () => false })
    const failed = Wait.waitFor(never, { kind: 'eval', web: 'desktop', code: 'ready' }, 1000, pace)
    check(failed).rejects.toThrow('wait eval desktop "ready": not within 1000 ms; last seen: false')
    check(failed).rejects.toBeInstanceOf(Wait.WaitTimeout)
  })

  test('a window by app, title or ref, and focused when asked', async () => {
    const { pace } = paced()
    let looks = 0
    const windows = scene({ windows: async () => [window('w3', 'notes', ++looks > 3)] })
    check((await Wait.waitFor(windows, { kind: 'window', match: 'notes' }, 1000, pace)).seen).toBe('w3 not focused')
    check((await Wait.waitFor(windows, { kind: 'window', match: 'w3', focused: true }, 1000, pace)).seen).toBe('w3 focused')
  })

  test('an element appears or goes, by its name or value', async () => {
    const { pace } = paced()
    let shown = true
    const tree = (name: string) => ({ text: '', windows: [], trees: { w1: [{ role: 'button', name, ref: 'w1.2', children: [] }] } }) as never
    const page = scene({ snapshot: async () => tree(shown ? 'Save' : 'Done') })
    check((await Wait.waitFor(page, { kind: 'element', text: 'save' }, 1000, pace)).seen).toBe('1 matching')
    shown = false
    check((await Wait.waitFor(page, { kind: 'element', text: 'save', gone: true }, 1000, pace)).seen).toBe('0 matching')
  })

  test('stable and network-idle wait for the quiet time after the last change', async () => {
    const { pace } = paced()
    let n = 0
    const changing = scene({ snapshot: async () => ({ text: String(Math.min(++n, 3)), windows: [], trees: {} }) })
    const stable = await Wait.waitFor(changing, { kind: 'stable', quiet: 500 }, 5000, pace)
    check(stable.seen).toStartWith('unchanged for ')
    check(stable.ms).toBeGreaterThanOrEqual(800)
    let asked = 0
    const requests = scene({ network: async () => ({ entries: [{ seq: 1, done: ++asked > 2 }], next: 2 }) as never })
    check((await Wait.waitFor(requests, { kind: 'network-idle', quiet: 200 }, 5000, pace)).seen).toStartWith('0 open; unchanged for ')
  })

  test('the command line names the condition and checks what it needs', () => {
    const none = new Map<string, string>()
    check(Wait.fromArgs(['page', 'desktop'], none)).toEqual({ condition: { kind: 'page', web: 'desktop' }, timeout: Wait.TIMEOUT_MS })
    check(Wait.fromArgs(['window', 'notes'], new Map([['focused', ''], ['timeout', '900']]))).toEqual({
      condition: { kind: 'window', match: 'notes', focused: true }, timeout: 900,
    })
    check(Wait.fromArgs(['eval', 'desktop', 'ready()'], none).condition).toEqual({ kind: 'eval', web: 'desktop', code: 'ready()' })
    check(Wait.fromArgs(['stable'], new Map([['window', 'w2'], ['quiet', '300']])).condition).toEqual({ kind: 'stable', window: 'w2', quiet: 300 })
    check(() => Wait.fromArgs(['soon'], none)).toThrow('wait: soon is not a condition')
    check(() => Wait.fromArgs(['eval', 'desktop'], none)).toThrow('wait eval: needs an expression')
    check(() => Wait.fromArgs(['page', 'x'], new Map([['timeout', 'later']]))).toThrow('wait: --timeout later')
  })

  test('a window going away, or every window, with the desktop and system pages not counted', async () => {
    const { pace } = paced()
    let looks = 0
    const shown = { rect: [0, 0, 1, 1], z: 0, focus: false, hidden: false, pid: 1 }
    const desktop = { ref: 'w0', id: 0, kind: 'desktop', app: null, title: null, mode: 'desktop', ...shown }
    const open = () => (++looks < 3 ? [window('w3', 'notes', true), window('w4', 'files', false)] : looks < 5 ? [window('w4', 'files', false)] : [])
    const windows = scene({ windows: async () => [desktop as never, ...open()] })
    check((await Wait.waitFor(windows, { kind: 'window', match: 'notes', gone: true }, 5000, pace)).seen).toBe('gone')
    const all = await Wait.waitFor(windows, { kind: 'window', gone: true }, 5000, pace)
    check([all.seen, all.value]).toEqual(['0 windows open', 0])
  })

  test('eval picks its page by app or by window, and gives back the value it turned true with', async () => {
    const { pace } = paced()
    const webs = [
      { name: 'desktop', app: null, kind: 'desktop', window: 0, title: null },
      { name: 'panel#2', app: 'panel', kind: 'app', window: 5, title: 'Agent' },
    ]
    const asked: string[] = []
    const pages = scene({
      webs: async () => webs as never,
      windows: async () => [window('w5', 'panel', false)],
      evaluate: async (web) => {
        asked.push(web)
        return { tasks: 3 }
      },
    })
    check((await Wait.waitFor(pages, { kind: 'eval', app: 'panel', code: 'x' }, 1000, pace)).value).toEqual({ tasks: 3 })
    await Wait.waitFor(pages, { kind: 'eval', window: 'w5', code: 'x' }, 1000, pace)
    check(asked).toEqual(['panel#2', 'panel#2'])
    const missing = Wait.waitFor(pages, { kind: 'eval', app: 'nope', code: 'x' }, 300, pace)
    await check(missing).rejects.toThrow('last seen: no page there yet')
  })

  test('stable watches one element by ref or selector and gives back its text', async () => {
    const { pace } = paced()
    let n = 0
    const node = (text: string, x: number) => ({ ref: 'w1.4', role: 'text', name: text, rect: [x, 0, 10, 10] })
    const moving = scene({
      query: async () => ({ window: 'w1', count: 1, nodes: [{ ...node('3 tasks', Math.min(++n, 3)), tag: 'p', visible: true }] }) as never,
      snapshot: async () => ({ text: '', windows: [], trees: { w1: [node('ready', 1)] } }) as never,
    })
    const bySelector = await Wait.waitFor(moving, { kind: 'stable', selector: '.count', quiet: 300 }, 5000, pace)
    check(bySelector.value).toEqual(['3 tasks'])
    check(bySelector.ms).toBeGreaterThanOrEqual(500)
    check((await Wait.waitFor(moving, { kind: 'stable', ref: 'w1.4', quiet: 300 }, 5000, pace)).value).toEqual(['ready'])
  })

  test('an element wait gives back how many matched and their texts; a timeout keeps the last value', async () => {
    const { pace } = paced()
    const tree = { text: '', windows: [], trees: { w1: [{ role: 'button', name: 'Save draft', ref: 'w1.2', children: [] }] } } as never
    const page = scene({ snapshot: async () => tree })
    check((await Wait.waitFor(page, { kind: 'element', text: 'save' }, 1000, pace)).value).toEqual({ count: 1, texts: ['Save draft'] })
    const never = scene({ evaluate: async () => 0 })
    const failed = await Wait.waitFor(never, { kind: 'eval', web: 'desktop', code: 'n' }, 300, pace).catch((error: unknown) => error)
    check((failed as Wait.WaitTimeout).value).toBe(0)
  })

  test('the command line takes the new forms', () => {
    const none = new Map<string, string>()
    check(Wait.fromArgs(['window'], new Map([['gone', '']])).condition).toEqual({ kind: 'window', gone: true })
    check(Wait.fromArgs(['window', 'notes'], new Map([['gone', '']])).condition).toEqual({ kind: 'window', match: 'notes', gone: true })
    check(() => Wait.fromArgs(['window'], none)).toThrow('wait window: needs a window')
    check(Wait.fromArgs(['eval', 'ready()'], new Map([['app', 'panel']])).condition).toEqual({ kind: 'eval', app: 'panel', code: 'ready()' })
    check(Wait.fromArgs(['eval', 'ready()'], new Map([['window', 'Agent']])).condition).toEqual({ kind: 'eval', window: 'Agent', code: 'ready()' })
    check(Wait.fromArgs(['stable'], new Map([['selector', '.count'], ['quiet', '200']])).condition).toEqual({ kind: 'stable', selector: '.count', quiet: 200 })
    check(Wait.fromArgs(['stable'], new Map([['ref', 'w1.4']])).condition).toEqual({ kind: 'stable', ref: 'w1.4' })
  })
})
