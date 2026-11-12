import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AppBackends } from '../src/backend.ts'
import { bindNatives } from '../src/sys/natives.ts'

bindNatives({ host: {} as never, sys: { platform: 'linux', argv: [], pid: 4300 } as never } as never)

describe('AppBackends sockets', () => {
  test('each runtime has its own directory per app', () => {
    assert.equal(AppBackends.socketDir('notes', 4100, '/run/user/1000/acde'), '/run/user/1000/acde/4100/notes')
    assert.notEqual(AppBackends.socketDir('notes', 4100, '/r'), AppBackends.socketDir('notes', 4200, '/r'))
  })

  test('only the directories of runtimes that are gone are swept', () => {
    const alive = (pid: number) => pid === 4200
    assert.deepEqual(AppBackends.stale(['4100', '4200', '4300', 'notes', '0', '012'], 4300, alive), ['4100'])
  })

  test('a socket path the system cannot bind is refused with its length', () => {
    assert.equal(AppBackends.tooLong('/tmp/acde/apps/1/notes/3000.sock', 'darwin'), null)
    const long = `/var/folders/${'x'.repeat(81)}/3000.sock`
    assert.match(AppBackends.tooLong(long, 'darwin')!, /is 104 bytes, the system allows 103/)
    assert.equal(AppBackends.tooLong(long, 'linux'), null)
    assert.match(AppBackends.tooLong(`/${'é'.repeat(60)}`, 'linux')!, /is 121 bytes/)
  })
})
