import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acdertCheckouts, acdertPackage, findAcdert, requireAcdert } from '../launcher.mjs'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

const EXE = process.platform === 'win32' ? '.exe' : ''

function binary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o755)
  return path
}

function acdeRoot(manifest: object = { name: 'acde', version: '0.1.0' }): string {
  const root = join(tmp(), 'acde')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  return root
}

describe('launcher: where acdert comes from', () => {
  const saved = { ACDERT: process.env['ACDERT'], PATH: process.env['PATH'] }
  let path: string

  beforeEach(() => {
    delete process.env['ACDERT']
    path = tmp()
    process.env['PATH'] = path
  })

  afterEach(() => {
    if (saved.ACDERT === undefined) delete process.env['ACDERT']
    else process.env['ACDERT'] = saved.ACDERT
    process.env['PATH'] = saved.PATH
  })

  test('an unpublished checkout finds the sibling acdert checkout: release first, then debug', async () => {
    const root = acdeRoot()
    const [release, debug] = acdertCheckouts(root) as [string, string]
    expect(release).toBe(join(root, '..', 'acdert', 'target', 'release', `acdert${EXE}`))
    binary(debug)
    expect(await requireAcdert(root)).toBe(debug)
    binary(release)
    expect(await requireAcdert(root)).toBe(release)
  })

  test('the sibling checkout comes before PATH, PATH is the last place', async () => {
    const root = acdeRoot()
    const onPath = binary(join(path, `acdert${EXE}`))
    expect(await requireAcdert(root)).toBe(onPath)
    const [release] = acdertCheckouts(root) as [string]
    binary(release)
    expect(await requireAcdert(root)).toBe(release)
  })

  test('nothing anywhere: the error lists every place it looked and how to fix it', async () => {
    const root = acdeRoot()
    const [release, debug] = acdertCheckouts(root) as [string, string]
    const error = await requireAcdert(root).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(error).toStartWith('no acdert found. Looked in:\n  ACDERT (not set)\n')
    for (const place of [acdertPackage(), release, debug, 'PATH']) expect(error).toContain(place)
    expect(error).toContain('ACDERT=/path/to/acdert acde dev')
    expect(error).toContain('cargo build --release -p acdert')
    expect(await findAcdert(false, root)).toBeNull()
  })

  test('a published acde does not look for a checkout', async () => {
    const root = acdeRoot({ name: 'acde', version: '9.9.9', optionalDependencies: {} })
    binary(acdertCheckouts(root)[0]!)
    const error = await requireAcdert(root).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(error).toContain('acdert has no build for')
    expect(error).not.toContain('target')
  })

  test('ACDERT wins; one that does not exist is an error, not a silent fallback', async () => {
    const root = acdeRoot()
    binary(acdertCheckouts(root)[0]!)
    const mine = binary(join(tmp(), 'mine', `acdert${EXE}`))
    process.env['ACDERT'] = mine
    expect(await requireAcdert(root)).toBe(mine)
    process.env['ACDERT'] = join(tmp(), 'gone')
    await expect(requireAcdert(root)).rejects.toThrow(/^ACDERT=.*gone: no such file/)
    expect(await findAcdert(false, root)).toBe(process.env['ACDERT'])
  })
})
