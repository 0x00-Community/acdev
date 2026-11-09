import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliFile, cliRuntime, requireAcdert } from '../launcher.mjs'
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

  test('nothing found: an English error says the runtime comes from the Dopame virtual machine or ACDERT', () => {
    expect(failure()).toBe(
      'acde dev needs the Dopame runtime (acdert), which is not part of acde. Run it inside the Dopame virtual ' +
      'machine, or set ACDERT to an acdert binary, or put acdert on PATH',
    )
  })
})

describe('launcher: what runs the CLI', () => {
  test('the bundled cli.js when there is one, else cli.ts; on bun, this bun', () => {
    expect(cliFile(checkout())).toEndWith(join('src', 'cli.ts'))
    expect(cliFile(install().root)).toEndWith(join('dist', 'cli.js'))
    expect(cliRuntime(checkout())).toBe(process.execPath)
  })
})
