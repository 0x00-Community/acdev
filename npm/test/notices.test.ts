import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NOTICES, OWN, REPO, libacde, noticeArgs, notices } from '../scripts/notices.ts'

const SCRIPT = join(libacde(), 'scripts', 'notices.ts')

describe('THIRD-PARTY-NOTICES.txt', () => {
  test('is made from the three Cargo.lock files and npm/, with the libacde parts, by the libacde script', () => {
    const args = noticeArgs('/r', '/l', true)
    expect(args[0]).toBe('/l/scripts/notices.ts')
    const locks = args.slice(args.indexOf('--cargo') + 1, args.indexOf('--vendor'))
    expect(locks).toEqual(['/r/Cargo.lock', '/r/crates/tool/Cargo.lock', '/r/crates/devd/Cargo.lock'])
    const given = [['--vendor', '/l/vendor'], ['--npm', '/r/npm'], ['--extra', '/l/scripts/notices/extra.json'], ['--out', '/r/THIRD-PARTY-NOTICES.txt']]
    for (const [flag, value] of given) {
      expect(args[args.indexOf(flag!) + 1]).toBe(value)
    }
    expect(args.at(-1)).toBe('--check')
    expect(noticeArgs('/r', '/l', false)).not.toContain('--check')
    expect(OWN).toEqual(expect.arrayContaining(['acdev', 'acde-hostwin', 'acdevtool', 'acdevd', 'libacde', '@dopame/acde-api']))
    expect(NOTICES).toBe(join(REPO, 'THIRD-PARTY-NOTICES.txt'))
  })

  test.skipIf(!existsSync(SCRIPT))('covers every dependency in the lock files and is up to date (bun run notices writes it again)', () => {
    const { status, output } = notices(true)
    expect(status, output).toBe(0)
  }, 120_000)
})
