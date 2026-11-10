import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NotificationEvent, WindowGrabLostEvent, WindowMenu, WindowsEvent } from '@dopame/acde-api'
import { PageCalls } from '../src/broker/calls/page.ts'
import { WindowCalls } from '../src/broker/calls/windows.ts'
import { Host } from '../src/host.ts'

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

const windowEvents = () => {
  const sent: WindowsEvent[] = []
  const host = {
    shell: { windows: () => [] },
    record: (id: number) => (id === 9 ? { id: 9, title: 'Notes', app: { id: 'notes' }, menus: [] } : undefined),
    toDesktop: (event: WindowsEvent) => void sent.push(event),
  }
  return { calls: new WindowCalls(host as never), sent, web: { kind: 'window', window: 9 } as never }
}

test('an app window tells the desktop what it does with typed window events', () => {
  const { calls, sent, web } = windowEvents()
  calls.self(web, 'setTitle', ['Draft'])
  const menus: WindowMenu[] = [{ id: 'file', label: 'File', items: [{ type: 'separator' }, { id: 'save', label: 'Save', action: true }] }]
  calls.self(web, 'setMenus', [menus])
  calls.self(web, 'minimize', [])
  calls.self(web, 'requestAttention', [])
  calls.self(web, 'ready', [])
  assert.deepEqual(sent, [
    { type: 'windowtitle', window: 9, appId: 'notes', title: 'Draft' },
    { type: 'windowmenus', window: 9, menus },
    { type: 'windowminimize', window: 9 },
    { type: 'windowattention', window: 9 },
    { type: 'windowready', window: 9 },
  ] satisfies WindowsEvent[])
})

test('a page notification reaches the desktop as a notification event', async () => {
  const sent: NotificationEvent[] = []
  const host = { desktopShown: () => true, shell: {}, toDesktop: (event: NotificationEvent) => void sent.push(event) }
  const page = new PageCalls(host as never)
  const web = { kind: 'window', window: 4, app: { id: 'mail', label: 'Mail' } }
  await page.call(web as never, 'notify', [{ title: 'New', body: 'Hello', tag: 't', icon: 'javascript:alert(1)' }])
  assert.deepEqual(sent, [
    { type: 'notification', window: 4, app: 'mail', label: 'Mail', title: 'New', body: 'Hello', icon: '', tag: 't' },
  ] satisfies NotificationEvent[])
})

test('a lost grab names one of the reasons the SDK lists', () => {
  const reasons: WindowGrabLostEvent['reason'][] = ['esc', 'other_window', 'focus_lost', 'denied']
  for (const reason of reasons) assert.equal(Host.lost(reason), reason)
  assert.equal(Host.lost(undefined), 'denied')
  assert.equal(Host.lost('something else'), 'denied')
})
