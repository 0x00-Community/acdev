import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acdertCheckouts, cliFile, cliRuntime, installed, requireAcdert } from '../launcher.mjs'
import { cleanup, tmp } from './helpers.ts'

afterAll(cleanup)

const WINDOWS = process.platform === 'win32'
const EXE = WINDOWS ? '.exe' : ''

function globalRuntime(home: string): string {
  return join(home, WINDOWS ? join('current', 'bin') : 'bin', `acdert${EXE}`)
}

function binary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o755)
  return path
}

function failure(root: string): string | null {
  try {
    requireAcdert(root)
    return null
  } catch (error) {
    return (error as Error).message
  }
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
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(version, 'lib', 'acde-api'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.0.3' }))
  writeFileSync(join(root, 'dist', 'cli.js'), '')
  writeFileSync(join(version, 'lib', 'acde-api', 'package.json'), '{}')
  return { home, version, root }
}

describe('launcher: where acdert comes from', () => {
  const saved = {
    ACDERT: process.env['ACDERT'],
    PATH: process.env['PATH'],
    PATHEXT: process.env['PATHEXT'],
    ACDE_INSTALL: process.env['ACDE_INSTALL'],
  }
  let path: string
  let home: string

  beforeEach(() => {
    delete process.env['ACDERT']
    path = tmp()
    home = tmp()
    process.env['PATH'] = path
    if (WINDOWS) process.env['PATHEXT'] = '.EXE'
    process.env['ACDE_INSTALL'] = home
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('a checkout finds the sibling acdert checkout: release first, then debug', () => {
    const root = checkout()
    expect(installed(root)).toBe(false)
    const [release, debug] = acdertCheckouts(root) as [string, string]
    expect(release).toBe(join(root, '..', 'acdert', 'target', 'release', `acdert${EXE}`))
    binary(debug)
    expect(requireAcdert(root)).toBe(debug)
    binary(release)
    expect(requireAcdert(root)).toBe(release)
  })

  test('the sibling checkout, then the global install, then PATH', () => {
    const root = checkout()
    const onPath = binary(join(path, WINDOWS ? 'acdert.EXE' : 'acdert'))
    expect(requireAcdert(root)).toBe(onPath)
    const global = binary(globalRuntime(home))
    expect(requireAcdert(root)).toBe(global)
    const [release] = acdertCheckouts(root) as [string]
    binary(release)
    expect(requireAcdert(root)).toBe(release)
  })

  test('nothing anywhere: the error lists every place it looked and how to fix it', () => {
    const root = checkout()
    const [release, debug] = acdertCheckouts(root) as [string, string]
    const error = failure(root)
    expect(error).toStartWith('no acdert found. Looked in:\n  ACDERT (not set)\n')
    for (const place of [release, debug, globalRuntime(home), 'PATH']) expect(error).toContain(place)
    expect(error).toContain('ACDERT=/path/to/acdert acde dev')
    expect(error).toContain('cargo build --release -p acdert')
  })

  test('an installed acde uses the acdert beside it and never looks for a checkout', () => {
    const at = install()
    expect(installed(at.root)).toBe(true)
    binary(acdertCheckouts(at.root)[0]!)
    const error = failure(at.root)
    expect(error).toContain(join(at.version, 'lib', 'acde', '..', '..', 'bin', `acdert${EXE}`))
    expect(error).not.toContain('target')
    expect(error).toContain('install acde again')
    const global = binary(globalRuntime(home))
    expect(requireAcdert(at.root)).toBe(global)
    const own = binary(join(at.version, 'bin', `acdert${EXE}`))
    expect(requireAcdert(at.root)).toBe(join(at.root, '..', '..', 'bin', `acdert${EXE}`))
    expect(own).toBe(join(at.version, 'bin', `acdert${EXE}`))
  })

  test('an installed acde reached through current/ lists its acdert once', () => {
    const at = install()
    process.env['ACDE_INSTALL'] = at.home
    mkdirSync(join(at.version, 'bin'))
    if (WINDOWS) symlinkSync(at.version, join(at.home, 'current'), 'junction')
    else {
      symlinkSync('versions/0.0.3', join(at.home, 'current'))
      symlinkSync('current/bin', join(at.home, 'bin'))
    }
    const error = failure(at.root)
    expect(error!.split('\n').filter((line) => line.includes(join('bin', `acdert${EXE}`)))).toHaveLength(1)
  })

  test('ACDERT wins; one that does not exist is an error, not a silent fallback', () => {
    const root = checkout()
    binary(acdertCheckouts(root)[0]!)
    const mine = binary(join(tmp(), 'mine', `acdert${EXE}`))
    process.env['ACDERT'] = mine
    expect(requireAcdert(root)).toBe(mine)
    process.env['ACDERT'] = join(tmp(), 'gone')
    expect(failure(root)).toMatch(/^ACDERT=.*gone: no such file/)
  })
})

describe('launcher: what runs the CLI', () => {
  test('the bundled cli.js when there is one, else cli.ts; on bun, this bun', () => {
    expect(cliFile(checkout())).toEndWith(join('src', 'cli.ts'))
    expect(cliFile(install().root)).toEndWith(join('dist', 'cli.js'))
    expect(cliRuntime(checkout())).toBe(process.execPath)
  })
})
