import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acdertCheckouts, cliFile, cliRuntime, findAcdert, installed, requireAcdert } from '../launcher.mjs'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

const EXE = process.platform === 'win32' ? '.exe' : ''

function binary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o755)
  return path
}

function checkout(): string {
  const root = join(tmp(), 'acde')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.1.0' }))
  writeFileSync(join(root, 'src', 'cli.ts'), '')
  return root
}

function install(): { home: string; version: string; root: string } {
  const home = tmp()
  const version = join(home, 'versions', '0.0.3')
  const root = join(version, 'lib', 'acde')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(version, 'lib', 'acde-api'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.0.3' }))
  writeFileSync(join(root, 'src', 'cli.js'), '')
  writeFileSync(join(version, 'lib', 'acde-api', 'package.json'), '{}')
  return { home, version, root }
}

describe('launcher: where acdert comes from', () => {
  const saved = { ACDERT: process.env['ACDERT'], PATH: process.env['PATH'], ACDE_INSTALL: process.env['ACDE_INSTALL'] }
  let path: string
  let home: string

  beforeEach(() => {
    delete process.env['ACDERT']
    path = tmp()
    home = tmp()
    process.env['PATH'] = path
    process.env['ACDE_INSTALL'] = home
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('a checkout finds the sibling acdert checkout: release first, then debug', async () => {
    const root = checkout()
    expect(installed(root)).toBe(false)
    const [release, debug] = acdertCheckouts(root) as [string, string]
    expect(release).toBe(join(root, '..', 'acdert', 'target', 'release', `acdert${EXE}`))
    binary(debug)
    expect(await requireAcdert(root)).toBe(debug)
    binary(release)
    expect(await requireAcdert(root)).toBe(release)
  })

  test('the sibling checkout, then the global install, then PATH', async () => {
    const root = checkout()
    const onPath = binary(join(path, `acdert${EXE}`))
    expect(await requireAcdert(root)).toBe(onPath)
    const global = binary(join(home, 'bin', `acdert${EXE}`))
    expect(await requireAcdert(root)).toBe(global)
    const [release] = acdertCheckouts(root) as [string]
    binary(release)
    expect(await requireAcdert(root)).toBe(release)
  })

  test('nothing anywhere: the error lists every place it looked and how to fix it', async () => {
    const root = checkout()
    const [release, debug] = acdertCheckouts(root) as [string, string]
    const error = await requireAcdert(root).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(error).toStartWith('no acdert found. Looked in:\n  ACDERT (not set)\n')
    for (const place of [release, debug, join(home, 'bin', `acdert${EXE}`), 'PATH']) expect(error).toContain(place)
    expect(error).toContain('ACDERT=/path/to/acdert acde dev')
    expect(error).toContain('cargo build --release -p acdert')
    expect(await findAcdert(false, root)).toBeNull()
  })

  test('an installed acde uses the acdert beside it and never looks for a checkout', async () => {
    const at = install()
    expect(installed(at.root)).toBe(true)
    binary(acdertCheckouts(at.root)[0]!)
    const error = await requireAcdert(at.root).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(error).toContain(join(at.version, 'lib', 'acde', '..', '..', 'bin', `acdert${EXE}`))
    expect(error).not.toContain('target')
    expect(error).toContain('install acde again')
    const global = binary(join(home, 'bin', `acdert${EXE}`))
    expect(await requireAcdert(at.root)).toBe(global)
    const own = binary(join(at.version, 'bin', `acdert${EXE}`))
    expect(await requireAcdert(at.root)).toBe(join(at.root, '..', '..', 'bin', `acdert${EXE}`))
    expect(own).toBe(join(at.version, 'bin', `acdert${EXE}`))
  })

  test('an installed acde reached through current/ lists its acdert once', async () => {
    const at = install()
    process.env['ACDE_INSTALL'] = at.home
    symlinkSync('versions/0.0.3', join(at.home, 'current'))
    symlinkSync('current/bin', join(at.home, 'bin'))
    mkdirSync(join(at.version, 'bin'))
    const error = await requireAcdert(at.root).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(error!.match(/bin\/acdert/g)).toHaveLength(1)
  })

  test('ACDERT wins; one that does not exist is an error, not a silent fallback', async () => {
    const root = checkout()
    binary(acdertCheckouts(root)[0]!)
    const mine = binary(join(tmp(), 'mine', `acdert${EXE}`))
    process.env['ACDERT'] = mine
    expect(await requireAcdert(root)).toBe(mine)
    process.env['ACDERT'] = join(tmp(), 'gone')
    await expect(requireAcdert(root)).rejects.toThrow(/^ACDERT=.*gone: no such file/)
    expect(await findAcdert(false, root)).toBe(process.env['ACDERT'])
  })
})

describe('launcher: what runs the CLI', () => {
  test('the bundled cli.js when there is one, else cli.ts; on bun, this bun', () => {
    expect(cliFile(checkout())).toEndWith(join('src', 'cli.ts'))
    expect(cliFile(install().root)).toEndWith(join('src', 'cli.js'))
    expect(cliRuntime(checkout())).toBe(process.execPath)
  })
})
