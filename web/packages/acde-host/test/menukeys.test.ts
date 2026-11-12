import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MenuKeys } from '../src/broker/menukeys.ts'
import type { WindowRecord, WireMenu } from '../src/broker/types.ts'
import { bindNatives } from '../src/sys/natives.ts'

const logged: string[] = []
bindNatives({ host: { log: (_level: number, _target: string, text: string) => void logged.push(text) }, sys: { platform: 'linux', argv: [], pid: 1 } } as never)

const item = (id: string, shortcut: string | undefined, more: { action?: boolean; disabled?: boolean } = {}) => ({
  id,
  label: id,
  ...(shortcut ? { shortcut } : {}),
  action: more.action ?? true,
  ...(more.disabled ? { disabled: true } : {}),
})
const file = (items: WireMenu['items']): WireMenu[] => [{ id: 'file', label: 'File', items }]

describe('MenuKeys', () => {
  test('only items that do something and are enabled take their shortcut', () => {
    const keys = MenuKeys.of(file([item('new', 'ctrl+n'), { type: 'separator' }, item('copy', 'ctrl+c', { disabled: true }), item('about', 'f1', { action: false }), item('plain', undefined)]))
    assert.deepEqual([...keys], [['ctrl+n', { menu: 'file', item: 'new' }]])
  })

  test('the first item with a shortcut keeps it', () => {
    const keys = MenuKeys.of([...file([item('new', 'ctrl+n')]), { id: 'edit', label: 'Edit', items: [item('next', 'ctrl+n')] }])
    assert.deepEqual(keys.get('ctrl+n'), { menu: 'file', item: 'new' })
  })

  test('setting menus again binds what is new and drops what is gone', () => {
    const calls: string[] = []
    const shell = {
      shortcut: (combo: string, scope: string, owner: number) => {
        if (combo === 'super+space') throw new Error('shortcut taken by Session owner 0')
        calls.push(`+${combo} ${scope} ${owner}`)
      },
      unshortcut: (combo: string, scope: string, owner: number) => void calls.push(`-${combo} ${scope} ${owner}`),
    }
    const record = { id: 5, menus: [] } as unknown as WindowRecord
    MenuKeys.bind(shell, record, file([item('new', 'ctrl+n'), item('open', 'ctrl+o'), item('spot', 'super+space')]))
    MenuKeys.bind(shell, record, file([item('new', 'ctrl+n'), item('save', 'ctrl+s')]))
    assert.deepEqual(calls, ['+ctrl+n menu 5', '+ctrl+o menu 5', '-ctrl+o menu 5', '+ctrl+s menu 5'])
    assert.deepEqual([...record.menuKeys!.keys()], ['ctrl+n', 'ctrl+s'])
    assert.match(logged.join('\n'), /menu shortcut super\+space: shortcut taken by Session/)
  })
})
