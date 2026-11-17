import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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
  const root = join(tmp(), 'acdev')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.0.5' }))
  writeFileSync(join(root, 'src', 'cli.ts'), '')
  return root
}

function install(): { root: string } {
  const root = join(tmp(), 'versions', '0.0.5', 'lib', 'acdev')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acde', version: '0.0.5' }))
  writeFileSync(join(root, 'dist', 'cli.js'), '')
  return { root }
}

describe('launcher: where acdert comes from', () => {
  const saved = {
    ACDEV_RUNTIME: process.env['ACDEV_RUNTIME'],
    PATH: process.env['PATH'],
    PATHEXT: process.env['PATHEXT'],
  }

  beforeEach(() => {
    delete process.env['ACDEV_RUNTIME']
    process.env['PATH'] = ''
    if (WINDOWS) process.env['PATHEXT'] = '.EXE'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('ACDEV_RUNTIME wins; one that does not exist is an error, not a silent fallback', () => {
    const mine = binary(join(tmp(), 'mine', `acdert${EXE}`))
    process.env['ACDEV_RUNTIME'] = mine
    expect(requireAcdert()).toBe(mine)
    process.env['ACDEV_RUNTIME'] = join(tmp(), 'gone')
    expect(failure()).toMatch(/^ACDEV_RUNTIME=.*gone: no such file/)
  })

  test('then acdert on PATH', () => {
    const dir = tmp()
    const onPath = binary(join(dir, `acdert${EXE}`))
    process.env['PATH'] = dir
    expect(requireAcdert()).toBe(onPath)
  })

  test('an installed acdev takes the acdert the installer put beside it, before PATH; ACDEV_RUNTIME still wins', () => {
    const { root } = install()
    binary(join(root, '..', 'acde-api', 'package.json'))
    const beside = binary(join(root, '..', '..', 'bin', `acdert${EXE}`))
    const dir = tmp()
    binary(join(dir, `acdert${EXE}`))
    const env = { PATH: dir, PATHEXT: '.EXE' }
    expect(requireAcdert(root, env)).toBe(beside)
    const mine = binary(join(tmp(), `acdert${EXE}`))
    expect(requireAcdert(root, { ...env, ACDEV_RUNTIME: mine })).toBe(mine)
    expect(requireAcdert(checkout(), env)).toBe(join(dir, `acdert${EXE}`))
  })

  test('nothing found: an English error names where the installer puts it, ACDEV_RUNTIME and PATH', () => {
    expect(failure()).toBe(
      'acdev dev needs the Dopame runtime (acdebin-dbg) and found none: ' +
      'set ACDEV_RUNTIME to an acdebin-dbg binary, or put acdebin-dbg on PATH (acdev doctor checks the whole setup)',
    )
    const { root } = install()
    binary(join(root, '..', 'acde-api', 'package.json'))
    let message = ''
    try {
      requireAcdert(root, { PATH: '' })
    } catch (error) {
      message = (error as Error).message
    }
    const beside = join(root, '..', '..', 'bin', `acdebin-dbg${EXE}`)
    expect(message).toBe(
      `acdev dev needs the Dopame runtime (acdebin-dbg) and found none: no ${beside}, ` +
      'which the acdev installer puts there: run the installer again, set ACDEV_RUNTIME to an acdebin-dbg binary, ' +
      'or put acdebin-dbg on PATH (acdev doctor checks the whole setup)',
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
    expect(findAcdert(root, { PATH: dir, ACDEV_RUNTIME: mine })).toEqual({ path: mine, from: 'ACDEV_RUNTIME' })
    expect(findAcdert(root, { PATH: dir })).toEqual({ path: beside, from: 'install' })
    expect(findAcdert(checkout(), { PATH: dir })).toEqual({ path: onPath, from: 'PATH' })
    const gone = findAcdert(root, { PATH: dir, ACDEV_RUNTIME: join(dir, 'gone') })
    expect(gone.path).toBeNull()
    expect(gone.from).toBe('ACDEV_RUNTIME')
    expect(gone.problem).toMatch(/^ACDEV_RUNTIME=.*gone: no such file; point ACDEV_RUNTIME at an acdebin-dbg binary, or unset it$/)
    const none = findAcdert(checkout(), { PATH: '' })
    expect(none).toEqual({
      path: null,
      from: null,
      problem: 'acdev dev needs the Dopame runtime (acdebin-dbg) and found none: ' +
        'set ACDEV_RUNTIME to an acdebin-dbg binary, or put acdebin-dbg on PATH',
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
    const one = cliEnv(exe, { Path: 'C:a;C:\b', ACDEV_HOST_RUNTIME: 'bun' }, 'win32')
    expect(pathKeys(one)).toEqual(['PATH'])
    expect(one['PATH']).toBe(`${bin}${delimiter}C:\a;C:\b`)
  })

  test('Windows: of several spellings the one given last wins, as a later spread does', () => {
    const both = cliEnv(exe, { Path: 'system', ACDEV_HOST_RUNTIME: 'bun', PATH: 'given' }, 'win32')
    expect(pathKeys(both)).toEqual(['PATH'])
    expect(both['PATH']).toBe(`${bin}${delimiter}given`)
  })

  test('no PATH at all: just the runtime directory', () => {
    expect(cliEnv(exe, { ACDEV_HOST_RUNTIME: 'bun' }, 'win32')['PATH']).toBe(`${bin}${delimiter}`)
  })

  test('elsewhere names are case-sensitive: only PATH is PATH', () => {
    const env = cliEnv(exe, { PATH: '/usr/bin', Path: 'other', ACDEV_HOST_RUNTIME: 'bun' }, 'linux')
    expect(env['PATH']).toBe(`${bin}${delimiter}/usr/bin`)
    expect(env['Path']).toBe('other')
  })
})

describe('start-up', () => {
  test('cli.ts imports only light modules up front; the rest loads when a command needs it', () => {
    const source = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8')
    const imported = [...source.matchAll(/^import (?!type )[^\n]* from '([^']+)'/gm)].map((m) => m[1]).sort()
    expect(imported).toEqual([
      './color.ts', './driver/types.ts', './help.ts', './output.ts', './runtime.ts', './starters.ts', './versions.ts',
      'acdev/launcher',
      'node:fs', 'node:path',
    ])
  })

  test.skipIf(WINDOWS)('bin/acdev (sh) asks bun for its version once, then again only when bun changes', () => {
    const top = join(tmp(), 'versions', '0.0.5')
    mkdirSync(join(top, 'bin'), { recursive: true })
    mkdirSync(join(top, 'lib', 'acdev', 'dist'), { recursive: true })
    copyFileSync(join(import.meta.dir, '../bin/acdev.sh'), join(top, 'bin', 'acde'))
    chmodSync(join(top, 'bin', 'acde'), 0o755)
    writeFileSync(join(top, 'lib', 'acdev', 'dist', 'cli.js'), "console.log('cli', process.argv.slice(2).join(' '))\n")
    const fake = join(tmp(), 'fake')
    mkdirSync(fake)
    const log = join(fake, 'calls')
    const bun = join(fake, 'bun')
    writeFileSync(bun, `#!/bin/sh\necho "$*" >>${JSON.stringify(log)}\n`
      + `if [ "$1" = --version ]; then echo 1.4.4; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
    chmodSync(bun, 0o755)
    const env = { PATH: `${fake}:/usr/bin:/bin`, HOME: fake }
    const run = () => Bun.spawnSync([join(top, 'bin', 'acde'), '-v'], { env }).stdout.toString()
    const probes = () => readFileSync(log, 'utf8').split('\n').filter((line) => line === '--version').length
    for (let i = 0; i < 3; i++) expect(run()).toBe('cli -v\n')
    expect(probes()).toBe(1)
    expect(existsSync(join(top, 'lib', 'runtime-cache'))).toBe(true)
    const later = new Date(Date.now() + 10_000)
    utimesSync(bun, later, later)
    expect(run()).toBe('cli -v\n')
    expect(probes()).toBe(2)
  })
})
