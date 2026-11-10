import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AcdeWindows, NativeWindow } from '@dopame/acde-api'
import { ServiceModules, type ServiceModulesHost } from '../../src/broker/access/modules.ts'
import { WindowCalls, type WindowsHost } from '../../src/broker/calls/windows.ts'
import { bindNatives, natives, type Natives } from '../../src/sys/natives.ts'

const logging = <T>(run: (logged: string[]) => T): T => {
  const logged: string[] = []
  let before: Natives | null = null
  try {
    before = natives()
  } catch {
  }
  bindNatives({ host: { log: (_: number, __: string, text: string) => void logged.push(text) } as never, sys: {} as never })
  try {
    return run(logged)
  } finally {
    if (before) bindNatives(before)
  }
}

const rows: NativeWindow[] = [{ id: 7, appId: 'notes', title: 'Notes', web: true, state: 'filled' }]

const setup = () => {
  const done: string[] = []
  const shell = {
    setState: (id: number, state: string) => void done.push(`state ${id} ${state}`),
    windows: () => [{ id: 7 }],
    focus: (id: number) => void done.push(`focus ${id}`),
    launch: (argv: string[]) => (done.push(`launch ${argv.join(' ')}`), 41),
    shortcut: (combo: string, scope: string, owner: number) => void done.push(`shortcut ${combo} ${scope} ${owner}`),
  }
  const windowsHost = {
    shell,
    record: (id: number) => (id === 7 ? { id, kind: 'web' } : undefined),
    closeWeb: async (id: number, force?: boolean) => (done.push(`${force ? 'kill' : 'close'} ${id}`), true),
    hide: (id: number, hidden: boolean) => void done.push(`${hidden ? 'hide' : 'show'} ${id}`),
    allow: () => {},
    claim: () => void done.push('claim'),
  } as unknown as WindowsHost
  const calls = new WindowCalls(windowsHost)
  const modules = new ServiceModules({
    shell,
    rows: () => rows.map((row) => ({ ...row })),
    windows: (method: string, args: unknown[]) => calls.windows(WindowCalls.SERVICE, method, args),
    session: () => ({ own: () => true, logout: () => void done.push('logout') }),
    refresh: () => [{ id: 'notes' }],
  } as unknown as ServiceModulesHost)
  return { modules, done }
}

test('a service gets the acde:windows a page gets: the same rows, calls and events', async () => {
  const { modules, done } = setup()
  const windows = modules.module('windows', 'clock') as Required<AcdeWindows>
  const members = ['on', 'list', 'launch', 'close', 'kill', 'focus', 'hide', 'show', 'requestState', 'invokeMenu', 'stats', 'animate', 'shortcut', 'unshortcut']
  assert.deepEqual(Object.keys(windows).sort(), [...members].sort())
  assert.deepEqual(windows.list(), rows)
  const state = windows.requestState(7, 'minimized')
  assert.ok(state instanceof Promise)
  await state
  await windows.focus(7)
  await windows.hide(7)
  await windows.kill(7)
  assert.equal(await windows.launch(['xterm'], { slot: true }), 41)
  await windows.shortcut('ctrl+alt+t')
  assert.deepEqual(done, ['state 7 minimized', 'focus 7', 'hide 7', 'kill 7', 'launch xterm', 'shortcut ctrl+alt+t desktop 0'], 'a service embeds nothing: slot is not claimed')
  await assert.rejects(windows.requestState(7, 'huge' as never), (e: Error & { status?: number }) => e instanceof TypeError && e.status === 400)
  assert.equal(windows.close(7), undefined)
  await new Promise((resolve) => setTimeout(resolve))
  assert.equal(done.at(-1), 'close 7')
})

test('a service listens to window events until it stops, and an unknown event type is a TypeError', () => {
  const { modules } = setup()
  const clock = modules.module('windows', 'clock') as Required<AcdeWindows>
  const other = modules.module('windows', 'other') as Required<AcdeWindows>
  const seen: string[] = []
  const off = clock.on('state', (event) => void seen.push(`clock ${event.window} ${event.state}`))
  clock.on('open', (event) => void seen.push(`clock open ${event.window}`))
  other.on('state', (event) => void seen.push(`other ${event.window} ${event.state}`))
  modules.emit({ type: 'windowstate', window: 7, state: 'filled', previous: 'normal' })
  modules.emit({ type: 'windowopen', window: 8, appId: 'mail', title: 'Mail' })
  modules.emit({ type: 'notification', window: 8 })
  assert.deepEqual(seen, ['clock 7 filled', 'other 7 filled', 'clock open 8'])
  assert.throws(() => clock.on('nosuch' as never, () => {}), (e: Error) => e instanceof TypeError && /acde:windows has no nosuch event \(open, close, title, state, /.test(e.message))
  assert.equal(off(), true)
  modules.release('other')
  modules.emit({ type: 'windowstate', window: 7, state: 'normal', previous: 'filled' })
  modules.emit({ type: 'windowopen', window: 9, appId: 'mail', title: 'Mail' })
  assert.deepEqual(seen.slice(3), ['clock open 9'])
})

test('one failing handler does not keep an event from the others', () => {
  const { modules } = setup()
  const windows = modules.module('windows', 'clock') as Required<AcdeWindows>
  const seen: number[] = []
  windows.on('close', () => {
    throw new Error('boom')
  })
  windows.on('close', (event) => void seen.push(event.window))
  const logged = logging((lines) => (modules.emit({ type: 'windowclose', window: 7 }), lines))
  assert.deepEqual(seen, [7])
  assert.ok(logged.some((line) => line.includes('boom')))
})

test('the other modules a service imports answer as the SDK types them', async () => {
  const { modules, done } = setup()
  const session = modules.module('session', 'clock') as { own(): boolean; logout(): Promise<void> }
  assert.equal(session.own(), true)
  const left = session.logout()
  assert.ok(left instanceof Promise)
  await left
  assert.deepEqual(done, ['logout'])
  const packages = modules.module('packages', 'clock') as { on(type: string, handler: (event: { apps: unknown[] }) => void): () => boolean; refresh(): Promise<unknown[]> }
  assert.ok(packages.refresh() instanceof Promise)
  const changes: unknown[] = []
  packages.on('changed', (event) => void changes.push(event.apps))
  modules.emit({ type: 'appschanged', apps: [] })
  assert.deepEqual(changes, [[]])
  assert.deepEqual(Object.keys(modules.module('desktop', 'clock')!), ['apps'])
  assert.equal(modules.module('permissions', 'clock'), null)
})
