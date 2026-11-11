import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { cliEnv, cliFile, cliRuntime, findAcdert, requireAcdert } from '../launcher.mjs'
import { cleanup, tmp, WINDOWS } from './helpers.ts'

afterAll(cleanup)

const EXE = WINDOWS ? '.exe' : ''

function binary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o755)
  return path
}

function failure(): string | null {
  try {
    requireAcdert()
    return null
  } catch (error) {
    return (error as Error).message
  }
}

function checkout(): string {
  const root = join(tmp(), 'acde')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.0.5' }))
  writeFileSync(join(root, 'src', 'cli.ts'), '')
  return root
}

function install(): { root: string } {
  const root = join(tmp(), 'versions', '0.0.5', 'lib', 'acde')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.0.5' }))
  writeFileSync(join(root, 'dist', 'cli.js'), '')
  return { root }
}

describe('launcher: where acdert comes from', () => {
  const saved = {
    ACDERT: process.env['ACDERT'],
    PATH: process.env['PATH'],
    PATHEXT: process.env['PATHEXT'],
  }

  beforeEach(() => {
    delete process.env['ACDERT']
    process.env['PATH'] = ''
    if (WINDOWS) process.env['PATHEXT'] = '.EXE'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('ACDERT wins; one that does not exist is an error, not a silent fallback', () => {
    const mine = binary(join(tmp(), 'mine', `acdert${EXE}`))
    process.env['ACDERT'] = mine
    expect(requireAcdert()).toBe(mine)
    process.env['ACDERT'] = join(tmp(), 'gone')
    expect(failure()).toMatch(/^ACDERT=.*gone: no such file/)
  })

  test('then acdert on PATH', () => {
    const dir = tmp()
    const onPath = binary(join(dir, `acdert${EXE}`))
    process.env['PATH'] = dir
    expect(requireAcdert()).toBe(onPath)
  })

  test('an installed acde takes the acdert the installer put beside it, before PATH; ACDERT still wins', () => {
    const { root } = install()
    binary(join(root, '..', 'acde-api', 'package.json'))
    const beside = binary(join(root, '..', '..', 'bin', `acdert${EXE}`))
    const dir = tmp()
    binary(join(dir, `acdert${EXE}`))
    const env = { PATH: dir, PATHEXT: '.EXE' }
    expect(requireAcdert(root, env)).toBe(beside)
    const mine = binary(join(tmp(), `acdert${EXE}`))
    expect(requireAcdert(root, { ...env, ACDERT: mine })).toBe(mine)
    expect(requireAcdert(checkout(), env)).toBe(join(dir, `acdert${EXE}`))
  })

  test('nothing found: an English error names where the installer puts it, ACDERT and PATH', () => {
    expect(failure()).toBe(
      'acde dev needs the Dopame runtime (acdert) and found none: ' +
      'set ACDERT to an acdert binary, or put acdert on PATH (acde doctor checks the whole setup)',
    )
    const { root } = install()
    binary(join(root, '..', 'acde-api', 'package.json'))
    let message = ''
    try {
      requireAcdert(root, { PATH: '' })
    } catch (error) {
      message = (error as Error).message
    }
    const beside = join(root, '..', '..', 'bin', `acdert${EXE}`)
    expect(message).toBe(
      `acde dev needs the Dopame runtime (acdert) and found none: no ${beside}, which the acde installer puts there: ` +
      'run the installer again, set ACDERT to an acdert binary, or put acdert on PATH ' +
      '(acde doctor checks the whole setup)',
    )
    expect(message).not.toContain('not part of acde')
  })

  test('findAcdert says where acdert came from, and what is wrong when it found none', () => {
    const { root } = install()
    binary(join(root, '..', 'acde-api', 'package.json'))
    const beside = binary(join(root, '..', '..', 'bin', `acdert${EXE}`))
    const dir = tmp()
    const onPath = binary(join(dir, `acdert${EXE}`))
    const mine = binary(join(tmp(), `acdert${EXE}`))
    expect(findAcdert(root, { PATH: dir, ACDERT: mine })).toEqual({ path: mine, from: 'ACDERT' })
    expect(findAcdert(root, { PATH: dir })).toEqual({ path: beside, from: 'install' })
    expect(findAcdert(checkout(), { PATH: dir })).toEqual({ path: onPath, from: 'PATH' })
    const gone = findAcdert(root, { PATH: dir, ACDERT: join(dir, 'gone') })
    expect(gone.path).toBeNull()
    expect(gone.from).toBe('ACDERT')
    expect(gone.problem).toMatch(/^ACDERT=.*gone: no such file; point ACDERT at an acdert binary, or unset it$/)
    const none = findAcdert(checkout(), { PATH: '' })
    expect(none).toEqual({
      path: null,
      from: null,
      problem: 'acde dev needs the Dopame runtime (acdert) and found none: ' +
        'set ACDERT to an acdert binary, or put acdert on PATH',
    })
  })
})

describe('launcher: what runs the CLI', () => {
  test('the bundled cli.js when there is one, else cli.ts; on bun, this bun', () => {
    expect(cliFile(checkout())).toEndWith(join('src', 'cli.ts'))
    expect(cliFile(install().root)).toEndWith(join('dist', 'cli.js'))
    expect(cliRuntime(checkout())).toBe(process.execPath)
  })
})

describe('launcher: the environment of the CLI', () => {
  const bin = join('opt', 'bun')
  const exe = join(bin, 'bun')
  const pathKeys = (env: Record<string, string | undefined>) =>
    Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')

  test('Windows: PATH is found under any case and left as one PATH key, the runtime first', () => {
    const one = cliEnv(exe, { Path: 'C:\a;C:\b', ACDE_HOST_RUNTIME: 'bun' }, 'win32')
    expect(pathKeys(one)).toEqual(['PATH'])
    expect(one['PATH']).toBe(`${bin}${delimiter}C:\a;C:\b`)
  })

  test('Windows: of several spellings the one given last wins, as a later spread does', () => {
    const both = cliEnv(exe, { Path: 'system', ACDE_HOST_RUNTIME: 'bun', PATH: 'given' }, 'win32')
    expect(pathKeys(both)).toEqual(['PATH'])
    expect(both['PATH']).toBe(`${bin}${delimiter}given`)
  })

  test('no PATH at all: just the runtime directory', () => {
    expect(cliEnv(exe, { ACDE_HOST_RUNTIME: 'bun' }, 'win32')['PATH']).toBe(`${bin}${delimiter}`)
  })

  test('elsewhere names are case-sensitive: only PATH is PATH', () => {
    const env = cliEnv(exe, { PATH: '/usr/bin', Path: 'other', ACDE_HOST_RUNTIME: 'bun' }, 'linux')
    expect(env['PATH']).toBe(`${bin}${delimiter}/usr/bin`)
    expect(env['Path']).toBe('other')
  })
})
