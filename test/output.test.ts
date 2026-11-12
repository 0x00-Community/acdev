import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Color } from '../src/color.ts'
import { Exit, Output } from '../src/output.ts'
import { Uninstall } from '../src/uninstall.ts'
import { cleanup, collect, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

function sink(isTTY: boolean): { isTTY: boolean; text: string; write(text: string): void } {
  return {
    isTTY,
    text: '',
    write(text: string) {
      this.text += text
    },
  }
}

afterAll(cleanup)

describe('colour and error output', () => {
  test('colour follows NO_COLOR, FORCE_COLOR (0 and false turn it off) and the stream written to', () => {
    const tty = { isTTY: true }
    const piped = { isTTY: false }
    expect(Color.enabled(tty, {})).toBe(true)
    expect(Color.enabled(piped, {})).toBe(false)
    expect(Color.enabled(tty, { TERM: 'dumb' })).toBe(false)
    expect(Color.enabled(tty, { NO_COLOR: '1' })).toBe(false)
    expect(Color.enabled(tty, { FORCE_COLOR: '0' })).toBe(false)
    expect(Color.enabled(tty, { FORCE_COLOR: 'false' })).toBe(false)
    expect(Color.enabled(piped, { FORCE_COLOR: '1' })).toBe(true)
    expect(Color.enabled(piped, { FORCE_COLOR: '' })).toBe(true)
    expect(Color.enabled(tty, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false)
  })

  test('a line on stderr colours only its label, and only when stderr shows colour', () => {
    const terminal = sink(true)
    Output.line('acde: warning: the SDK is older', terminal, {})
    Output.line('error: windows (desktop): app "p1" requires office', terminal, {})
    Output.line('hint: list the capability in "optional"', terminal, {})
    Output.line('acde: built app p1', terminal, {})
    expect(terminal.text).toBe([
      'acde: \x1b[33mwarning:\x1b[39m the SDK is older',
      '\x1b[1;31merror:\x1b[22;39m windows (desktop): app "p1" requires office',
      '\x1b[2mhint:\x1b[22m list the capability in "optional"',
      'acde: built app p1',
      '',
    ].join('\n'))
    const piped = sink(false)
    Output.line('acde: warning: the SDK is older', piped, {})
    expect(piped.text).toBe('acde: warning: the SDK is older\n')
    const off = sink(true)
    Output.line('error: x', off, { FORCE_COLOR: '0' })
    expect(off.text).toBe('error: x\n')
    const painted = sink(true)
    Output.line('\x1b[1;31merror:\x1b[22;39m x', painted, {})
    expect(painted.text).toBe('\x1b[1;31merror:\x1b[22;39m x\n')
  })

  test('an error says its message: no Error: prefix, a stack only with ACDE_DEBUG', () => {
    const error = new Error('Error: no web nope (acde webs lists them)')
    const plain = sink(false)
    Output.fail(error, plain, {})
    expect(plain.text).toBe('acde: no web nope (acde webs lists them)\n')
    const terminal = sink(true)
    Output.fail('no desktop nope', terminal, {})
    expect(terminal.text).toBe('\x1b[1;31macde:\x1b[22;39m no desktop nope\n')
    const debugging = sink(false)
    Output.fail(error, debugging, { ACDE_DEBUG: '1' })
    expect(debugging.text).toStartWith('acde: no web nope (acde webs lists them)\nError: Error: no web nope')
    expect(debugging.text).toContain('    at ')
  })

  test('console.error goes through acde, not the runtime: same bytes on every runtime', () => {
    const terminal = sink(true)
    const [error, warn] = [console.error, console.warn]
    try {
      Output.install(terminal)
      console.error('acde: %s', 'warning: old')
      console.warn('note: later')
    } finally {
      console.error = error
      console.warn = warn
    }
    expect(terminal.text).toBe('acde: \x1b[33mwarning:\x1b[39m old\n\x1b[2mnote:\x1b[22m later\n')
  })

  test('the command line: an unknown command is one line, uncoloured with NO_COLOR, coloured label with FORCE_COLOR',
    async () => {
      const cwd = tmp()
      const plain = await collect([process.execPath, CLI, 'frob'], { cwd, env: env({ NO_COLOR: '1' }) })
      expect(plain.code).toBe(1)
      expect(plain.stderr).toMatch(/^acde: [^\n]*frob[^\n]*\n$/)
      expect(plain.stderr).not.toContain('Error:')
      const colour = env({ FORCE_COLOR: '1', NO_COLOR: '' })
      const forced = await collect([process.execPath, CLI, 'frob'], { cwd, env: colour })
      expect(forced.stderr).toStartWith('\x1b[1;31macde:\x1b[22;39m ')
      expect(forced.stderr.split('\n')).toHaveLength(2)
    })

  test('exit codes: 0 done, 1 error, 2 nothing done, 3 cancelled; the CLI reference lists them', () => {
    expect(Exit).toEqual({ DONE: 0, ERROR: 1, NOTHING: 2, DECLINED: 3 })
    expect([Uninstall.IN_USE, Uninstall.NOT_INSTALLED, Uninstall.DECLINED]).toEqual([1, 2, 3])
    const reference = readFileSync(join(import.meta.dir, '../skills/acde/references/reference/cli.md'), 'utf8')
    const table = reference.slice(reference.indexOf('Exit codes are the same for every command'))
    for (const code of Object.values(Exit)) expect(table).toMatch(new RegExp(`^\\| ${code} \\| `, 'm'))
  })

  test('an option value error reads command, option, value, what it takes, and the help to read', () => {
    expect(Output.option('test', 'timeout', 'x', 'milliseconds per test').message)
      .toBe('test: --timeout x: milliseconds per test (acde test --help)')
  })
})
