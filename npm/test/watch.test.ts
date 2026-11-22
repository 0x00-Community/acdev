import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Settled, TreeWatch } from '../src/watch.ts'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  for (const started = Date.now(); !ok(); await Bun.sleep(20)) {
    if (Date.now() - started > ms) throw new Error(`no ${what} within ${ms} ms`)
  }
}

describe('TreeWatch (the Linux way: one watch per directory)', () => {
  test('an atomic save, then in-place writes, are each seen; so are new directories; skipped ones are not watched',
    async () => {
      const root = tmp()
      mkdirSync(join(root, 'src'))
      mkdirSync(join(root, 'node_modules'))
      writeFileSync(join(root, 'src', 'util.js'), '0')
      const seen: string[] = []
      const tree = TreeWatch.start(root, (dir) => basename(dir) === 'node_modules', (file) => seen.push(file),
        'linux') as TreeWatch
      try {
        expect([...tree.watched].sort()).toEqual([root, join(root, 'src')].sort())
        const util = join('src', 'util.js')
        const count = () => seen.filter((file) => file === util).length
        writeFileSync(join(root, 'src', 'util.js.tmp'), '1')
        renameSync(join(root, 'src', 'util.js.tmp'), join(root, 'src', 'util.js'))
        await until('the atomic save', () => count() >= 1)
        const after = count()
        writeFileSync(join(root, 'src', 'util.js'), '2')
        await until('the in-place write', () => count() > after)
        const again = count()
        writeFileSync(join(root, 'src', 'util.js'), '3')
        await until('a second in-place write', () => count() > again)
        mkdirSync(join(root, 'lib'))
        writeFileSync(join(root, 'lib', 'a.js'), 'a')
        await until('the file in the new directory', () => seen.includes(join('lib', 'a.js')))
        expect(tree.watched).toContain(join(root, 'lib'))
        if (process.platform !== 'win32') {
          rmSync(join(root, 'lib'), { recursive: true })
          await until('the removed directory dropped', () => !tree.watched.includes(join(root, 'lib')))
        }
      } finally {
        tree.close()
      }
      expect(tree.watched).toEqual([])
    }, 30_000)
})

describe('Settled (events whose file did not change)', () => {
  test('a file untouched since the watch began is not a change; writes, renames and deletes are', async () => {
    const root = tmp()
    const file = join(root, 'worker')
    writeFileSync(file, 'a')
    await Bun.sleep(20)
    const settled = new Settled()
    expect(settled.changed(file)).toBe(false)
    expect(settled.changed(file)).toBe(false)
    writeFileSync(file, 'ab')
    expect(settled.changed(file)).toBe(true)
    expect(settled.changed(file)).toBe(false)
    renameSync(file, join(root, 'moved'))
    expect(settled.changed(file)).toBe(true)
    expect(settled.changed(join(root, 'moved'))).toBe(true)
    rmSync(join(root, 'moved'))
    expect(settled.changed(join(root, 'moved'))).toBe(true)
    expect(settled.changed(join(root, 'never'))).toBe(true)
  })

  test.skipIf(process.platform !== 'darwin')('copying a file out of the project (an APFS clone) does not report the source', async () => {
    const root = tmp()
    const out = tmp()
    mkdirSync(join(root, 'public', 'bin'), { recursive: true })
    writeFileSync(join(root, 'public', 'bin', 'worker'), Buffer.alloc(1 << 20, 7))
    await Bun.sleep(50)
    const seen: string[] = []
    const watching = TreeWatch.start(root, () => false, (file) => seen.push(file))
    try {
      await Bun.sleep(100)
      for (let i = 0; i < 3; i++) cpSync(join(root, 'public'), join(out, `web${i}`), { recursive: true })
      await Bun.sleep(400)
      expect(seen).toEqual([])
      writeFileSync(join(root, 'public', 'bin', 'worker'), Buffer.alloc(1 << 20, 8))
      await until('the real write', () => seen.includes(join('public', 'bin', 'worker')))
    } finally {
      watching.close()
    }
  })
})
