import assert from 'node:assert/strict'
import { test } from 'node:test'
import pkg from '../package.json' with { type: 'json' }
import { UserAgent } from '../src/useragent.ts'

test('pages see one Linux environment on every host, with the real acdert version', () => {
  assert.deepEqual(UserAgent.current, {
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) acdert/${pkg.version}`,
    platform: 'Linux x86_64',
  })
})
