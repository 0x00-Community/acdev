import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NativeWindow } from '@dopame/acde-api'
import type { RawShellEvent } from '../src/native.ts'
import { WindowRecords } from '../src/broker/records.ts'
import type { WindowRecord } from '../src/broker/types.ts'
import type { Web } from '../src/broker/web.ts'
import { WindowList } from '../src/remote.ts'
import { Rpc } from '../src/rpc.ts'

const session = () => {
  const told: RawShellEvent[] = []
  const records = new WindowRecords({ shell: () => ({ windows: () => [] }) as never, webs: () => [], toDesktop: (event) => void told.push(event as RawShellEvent) })
  const web = (id: number, appId: string, label: string): WindowRecord => {
    const record = { id, kind: 'web', appId, title: label, owner: null, web: null, app: { id: appId, label } as never, menus: [] } satisfies WindowRecord
    records.set(id, record)
    return record
  }
  return { records, told, web }
}

test('the Broker has a row for every window the desktop is told about, with its state', () => {
  const { records, told, web } = session()
  web(7, 'notes', 'Notes')
  web(8, 'mail', 'Mail').title = null
  records.shellEvent({ type: 'windowopen', window: 3, appId: 'org.gnome.Calculator', title: 'Calculator' })
  records.set(4, { id: 4, kind: 'native', appId: 'embedded', title: 'Embedded', owner: {} as Web, web: null, app: null, menus: [] })
  assert.deepEqual(records.rows(), [
    { id: 7, appId: 'notes', title: 'Notes', web: true, state: 'normal' },
    { id: 8, appId: 'mail', title: 'Mail', web: true, state: 'normal' },
    { id: 3, appId: 'org.gnome.Calculator', title: 'Calculator', state: 'normal' },
  ] satisfies NativeWindow[])
  records.shellEvent({ type: 'windowstate', window: 7, state: 'filled', previous: 'normal' })
  records.shellEvent({ type: 'windowstate', window: 3, state: 'minimized', previous: 'normal' })
  records.shellEvent({ type: 'windowstate', window: 8, state: 'sideways', previous: 'normal' })
  assert.deepEqual(records.rows().map((row) => row.state), ['filled', 'normal', 'minimized'])
  assert.deepEqual(told.filter((event) => event.type === 'windowstate').map((event) => event.window), [7, 3, 8], 'the events still go on to the desktop')
})

test('a page that starts later lists the windows that were already open', () => {
  const { records, web } = session()
  web(7, 'notes', 'Notes')
  records.shellEvent({ type: 'windowstate', window: 7, state: 'minimized', previous: 'normal' })
  web(9, 'monitor', 'Monitor')
  const late = new WindowList(new Rpc(() => {}), records.rows())
  assert.deepEqual(late.api.list(), [
    { id: 7, appId: 'notes', title: 'Notes', web: true, state: 'minimized' },
    { id: 9, appId: 'monitor', title: 'Monitor', web: true, state: 'normal' },
  ])
  late.deliver({ type: 'windowopen', window: 9, appId: 'monitor', title: 'Monitor', web: true })
  late.deliver({ type: 'windowstate', window: 7, state: 'normal', previous: 'minimized' })
  late.deliver({ type: 'windowopen', window: 10, appId: 'mail', title: 'Mail', web: true })
  assert.deepEqual(late.api.list().map((row) => [row.id, row.state]), [[7, 'normal'], [9, 'normal'], [10, 'normal']], 'its own open event adds no second row')
  const rows = late.api.list()
  rows.pop()
  assert.equal(late.api.list().length, 3, 'list() hands out copies')
})
