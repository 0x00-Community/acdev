import assert from 'node:assert/strict'
import { test } from 'node:test'
import pkg from '../package.json' with { type: 'json' }
import { UserAgent } from '../src/useragent.ts'

test('pages see the system acdert runs on', () => {
  assert.deepEqual(UserAgent.of('darwin'), { userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) acdert/${pkg.version}`, platform: 'MacIntel' })
  assert.equal(UserAgent.of('win32').platform, 'Win32')
  assert.match(UserAgent.of('win32').userAgent, /\(Windows NT 10\.0; Win64; x64\)/)
  assert.equal(UserAgent.of('linux').platform, 'Linux x86_64')
  assert.match(UserAgent.of('linux').userAgent, /\(X11; Linux x86_64\)/)
})
