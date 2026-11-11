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

test('the refusal says why this window cannot be minimized here', () => {
  const row = (fields: Record<string, unknown>) => ({ id: 9, mode: 'free', minimize: false, ...fields }) as never
  assert.equal(WindowCalls.unminimizable(row({ minimize: true })), null)
  assert.equal(WindowCalls.unminimizable(row({ minimize: undefined })), null, 'a compositor that does not say is taken at its word')
  assert.equal(WindowCalls.unminimizable(undefined), null)
  assert.equal(WindowCalls.unminimizable(row({})), 'a standalone app has no Dock to bring it back')
  assert.equal(WindowCalls.unminimizable(row({ mode: 'fullscreen' })), "it fills the host window, which only the host window's own controls minimize here")
  assert.equal(WindowCalls.unminimizable(row({ mode: 'pinned' })), 'a pinned window stays where it is')
  assert.equal(WindowCalls.unminimizable(row({ id: 0, mode: 'fullscreen' })), 'the desktop stays behind every window')
})

test('the main window of a single-app session refuses minimize() where the host cannot carry it out', () => {
  const states: string[] = []
  const host = {
    shell: { setState: (_: number, state: string) => void states.push(state), windows: () => [{ id: 9, mode: 'fullscreen', minimize: false }] },
    record: (id: number) => (id === 9 ? { id: 9, app: { id: 'app' } } : undefined),
  }
  const windows = new WindowCalls(host as never)
  assert.throws(() => windows.self({ kind: 'window', window: 9 } as never, 'minimize', []), (e: Error & { code?: string; status?: number }) =>
    e.code === 'unavailable' && e.status === 409 && e.message === "window 9 cannot be minimized: it fills the host window, which only the host window's own controls minimize here")
  assert.deepEqual(states, [])
})

test('other windows minimize as before', () => {
  const { windows, states, web } = calls(true)
  windows.self(web, 'minimize', [])
  assert.deepEqual(states, ['minimized'])
})

const windowEvents = () => {
  const sent: WindowsEvent[] = []
  const asked: string[] = []
  const host = {
    shell: { windows: () => [] },
    record: (id: number) => (id === 9 ? { id: 9, title: 'Notes', app: { id: 'notes' }, menus: [] } : undefined),
    toDesktop: (event: WindowsEvent) => void sent.push(event),
  }
  const rpc = { call: (scope: string, method: string) => void asked.push(`${scope}.${method}`) }
  return { calls: new WindowCalls(host as never), sent, asked, web: { kind: 'window', window: 9, rpc } as never }
}

test('without runtime window states a window minimizes itself through its own surface', () => {
  const { calls, sent, asked, web } = windowEvents()
  calls.self(web, 'minimize', [])
  assert.deepEqual(asked, ['window.minimize'])
  assert.deepEqual(sent, [])
})

test('an app window tells the desktop what it does with typed window events', () => {
  const { calls, sent, web } = windowEvents()
  calls.self(web, 'setTitle', ['Draft'])
  const menus: WindowMenu[] = [{ id: 'file', label: 'File', items: [{ type: 'separator' }, { id: 'save', label: 'Save', action: true }] }]
  calls.self(web, 'setMenus', [menus])
  calls.self(web, 'requestAttention', [])
  calls.self(web, 'ready', [])
  assert.deepEqual(sent, [
    { type: 'windowtitle', window: 9, appId: 'notes', title: 'Draft' },
    { type: 'windowmenus', window: 9, menus },
    { type: 'windowattention', window: 9 },
    { type: 'windowready', window: 9 },
  ] satisfies WindowsEvent[])
})

test('a page notification reaches the desktop as a notification event', async () => {
  const sent: NotificationEvent[] = []
  let supported = true
  const host = { desktopShown: () => true, shell: {}, notifications: () => supported, toDesktop: (event: NotificationEvent) => void sent.push(event) }
  const page = new PageCalls(host as never)
  const web = { kind: 'window', window: 4, app: { id: 'mail', label: 'Mail' } }
  await page.call(web as never, 'notify', [{ title: 'New', body: 'Hello', tag: 't', icon: 'javascript:alert(1)' }])
  assert.deepEqual(sent, [
    { type: 'notification', window: 4, app: 'mail', label: 'Mail', title: 'New', body: 'Hello', icon: '', tag: 't' },
  ] satisfies NotificationEvent[])
  supported = false
  await assert.rejects(page.call(web as never, 'notify', [{ title: 'Again', body: '', tag: '', icon: '' }]), (e: Error & { status?: number; code?: string }) =>
    e.status === 501 && e.code === 'unsupported')
  assert.equal(sent.length, 1)
})

test('a lost grab names one of the reasons the SDK lists', () => {
  const reasons: WindowGrabLostEvent['reason'][] = ['esc', 'other_window', 'focus_lost', 'denied']
  for (const reason of reasons) assert.equal(Host.lost(reason), reason)
  assert.equal(Host.lost(undefined), 'denied')
  assert.equal(Host.lost('something else'), 'denied')
})
