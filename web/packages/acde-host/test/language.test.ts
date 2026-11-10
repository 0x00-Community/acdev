import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SessionLanguage } from '../src/language.ts'

describe('SessionLanguage.of', () => {
  test('the locale variables decide when one is set', () => {
    assert.deepEqual(SessionLanguage.of({ LANG: 'zh_CN.UTF-8' }, ['en-US']), { language: 'zh-CN', languages: ['zh-CN', 'zh'] })
    assert.deepEqual(SessionLanguage.of({ LANGUAGE: 'de_DE:fr', LANG: 'C' }, ['ja-JP']), { language: 'de-DE', languages: ['de-DE', 'de', 'fr', 'en-US', 'en'] })
  })

  test("without them the operating system's preferred languages are used", () => {
    assert.deepEqual(SessionLanguage.of({}, ['zh-CN', 'en-US']), { language: 'zh-CN', languages: ['zh-CN', 'zh', 'en-US', 'en'] })
    assert.deepEqual(SessionLanguage.of({ LANG: '' }, ['zh-Hans-CN', 'en']), { language: 'zh-Hans-CN', languages: ['zh-Hans-CN', 'zh', 'en'] })
    assert.deepEqual(SessionLanguage.of({}, []), {})
  })
})
