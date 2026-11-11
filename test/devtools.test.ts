import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Devtools, type Lookup } from '../src/devtools.ts'

function lookup(platform: NodeJS.Platform, present: readonly string[], env: Record<string, string> = {}): Lookup {
  return { platform, env, home: '/Users/me', exists: (path) => present.includes(path) }
}

describe('acde devtools', () => {
  test('Windows: Edge, else Chrome, under Program Files or the user profile', () => {
    const env = {
      'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    }
    const edge = join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    const chrome = join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    expect(Devtools.browser(lookup('win32', [chrome, edge], env))).toEqual({ name: 'Microsoft Edge', path: edge })
    expect(Devtools.browser(lookup('win32', [chrome], env))).toEqual({ name: 'Google Chrome', path: chrome })
    expect(Devtools.browser(lookup('win32', [], env))).toBeNull()
  })

  test('macOS: the Chrome app, else the Edge app, in /Applications or ~/Applications', () => {
    const chrome = join('/Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
    const edge = join('/Users/me', 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')
    expect(Devtools.browser(lookup('darwin', [edge, chrome]))).toEqual({ name: 'Google Chrome', path: chrome })
    expect(Devtools.browser(lookup('darwin', [edge]))).toEqual({ name: 'Microsoft Edge', path: edge })
  })

  test('Linux: chrome, chromium or microsoft-edge on PATH', () => {
    const env = { PATH: ['/usr/local/bin', '/usr/bin'].join(process.platform === 'win32' ? ';' : ':') }
    const chromium = join('/usr/bin', 'chromium')
    const edge = join('/usr/local/bin', 'microsoft-edge')
    expect(Devtools.browser(lookup('linux', [edge, chromium], env))).toEqual({ name: 'chromium', path: chromium })
    expect(Devtools.browser(lookup('linux', [edge], env))).toEqual({ name: 'microsoft-edge', path: edge })
    expect(Devtools.browser(lookup('linux', [], env))).toBeNull()
  })

  test('ACDE_BROWSER names the browser; none opens nothing', () => {
    const chromium = join('/usr/bin', 'chromium')
    expect(Devtools.browser(lookup('linux', [chromium], { PATH: '/usr/bin', ACDE_BROWSER: 'none' }))).toBeNull()
    expect(Devtools.browser(lookup('linux', [], { ACDE_BROWSER: '/opt/brave' })))
      .toEqual({ name: '/opt/brave', path: '/opt/brave' })
  })

  test('the DevTools address carries the target socket and the token', () => {
    const endpoint = { port: 9300, token: 'abc' }
    const target = { id: '7', title: 'Notes', type: 'page', url: 'acde://notes/', webSocketDebuggerUrl: '' }
    const withToken = { ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:9300/devtools/page/7?token=abc' }
    const without = { ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:9300/devtools/page/7' }
    const expected = 'devtools://devtools/bundled/inspector.html?ws='
      + '127.0.0.1%3A9300%2Fdevtools%2Fpage%2F7%3Ftoken%3Dabc'
    expect(Devtools.url(withToken, endpoint)).toBe(expected)
    expect(Devtools.url(without, endpoint)).toBe(expected)
  })

  test('a target by id; an unknown one lists the targets', () => {
    const page = { id: '7', title: 'Notes', type: 'page', url: 'acde://notes/', webSocketDebuggerUrl: 'ws://x/7' }
    expect(Devtools.pick([page], ['notes#7', '7'], 'notes')).toBe(page)
    expect(() => Devtools.pick([page], ['nope'], 'nope'))
      .toThrow('no DevTools target for nope; the targets are:\n  7  page  Notes')
    expect(() => Devtools.pick([], ['7'], null)).toThrow('no DevTools target for the focused page (the list is empty)')
  })

  test('a target by title, by the title without its app id, or the services by name', () => {
    const socket = 'ws://x/'
    const desktop = { id: 'desktop', title: 'Dopame (desktop)', type: 'page', url: '', webSocketDebuggerUrl: socket }
    const notes = { id: 'notes#7', title: 'My Notes (notes)', type: 'page', url: '', webSocketDebuggerUrl: socket }
    const services = {
      id: 'broker', title: 'services: assistant, store', type: 'service', url: '', webSocketDebuggerUrl: socket,
    }
    const targets = [desktop, notes, services]
    expect(Devtools.pick(targets, ['My Notes (notes)'], 'My Notes (notes)')).toBe(notes)
    expect(Devtools.pick(targets, ['my notes'], 'my notes')).toBe(notes)
    expect(Devtools.pick(targets, ['dopame'], 'dopame')).toBe(desktop)
    expect(Devtools.pick(targets, ['broker'], 'broker')).toBe(services)
    expect(Devtools.pick(targets, ['services'], 'services')).toBe(services)
    expect(Devtools.pick(targets, ['Store'], 'Store')).toBe(services)
    expect(() => Devtools.pick(targets, ['ledger'], 'ledger')).toThrow('no DevTools target for ledger')
  })

  test('acdert answers a port, with or without a token', () => {
    expect(Devtools.endpoint({ port: 9300, token: 'abc' })).toEqual({ port: 9300, token: 'abc' })
    expect(Devtools.endpoint({ port: 9300 })).toEqual({ port: 9300 })
    expect(Devtools.endpoint({ port: 9300, token: '' })).toEqual({ port: 9300 })
    expect(() => Devtools.endpoint({ token: 'abc' })).toThrow('acdert answered devtools without a port')
  })

  test('without a token the list and the socket are used as given', async () => {
    const asked: [string, RequestInit | undefined][] = []
    const socket = 'ws://127.0.0.1:9300/devtools/page/7'
    const page = { id: '7', title: 'Notes', type: 'page', url: 'acde://notes/', webSocketDebuggerUrl: socket }
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push([url, init])
      return new Response(JSON.stringify([page]))
    }) as unknown as typeof fetch
    expect(await Devtools.targets({ port: 9300 }, fetcher)).toEqual([page])
    expect(asked[0]![0]).toBe('http://127.0.0.1:9300/json/list')
    expect(asked[0]![1]?.headers).toBeUndefined()
    await Devtools.targets({ port: 9300, token: 'abc' }, fetcher)
    expect(asked[1]![0]).toBe('http://127.0.0.1:9300/json/list?token=abc')
    expect(asked[1]![1]?.headers).toEqual({ authorization: 'Bearer abc' })
    expect(Devtools.url(page, { port: 9300 }))
      .toBe('devtools://devtools/bundled/inspector.html?ws=127.0.0.1%3A9300%2Fdevtools%2Fpage%2F7')
  })
})
