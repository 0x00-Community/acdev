import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_LEVEL, platformSupport, RUNNING_MODES } from '@dopame/acde-api/manifest'
import { Project } from '../src/app.ts'
import { Color } from '../src/color.ts'
import { ACTIONS } from '../src/driver/acde.ts'
import { Help } from '../src/help.ts'
import { Tools } from '../src/tools.ts'
import { cleanup, collect, env, standIn, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const APP = join(import.meta.dir, 'fixtures/app')

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

afterAll(cleanup)

describe('acde check --platform', () => {
  function project(config: object): string {
    const dir = tmp()
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify(config))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    return dir
  }

  test('an app requiring network fails on Windows in every mode; optional, it passes with a note', async () => {
    const required = project({ type: 'app', id: 'net', capabilities: { network: true, terminal: true, fs: true } })
    const failed = await cli(['check', '--platform', 'windows'], required)
    expect(failed.code).toBe(1)
    for (const mode of RUNNING_MODES.filter((m) => platformSupport('win32', m)))
      expect(failed.stderr).toContain(`error: windows (${mode}): app "net" requires network, which this mode lacks`)
    expect(failed.stderr).not.toContain('requires fs')
    expect(failed.stderr).not.toContain('requires terminal')
    const linux = await cli(['check', '--platform', 'linux'], required)
    expect(linux.code).toBe(0)
    expect(linux.stdout).toContain('linux (session, desktop, standalone): every required capability is there')
    const here = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform as string]!
    const plain = await cli(['check'], required)
    const named = await cli(['check', '--platform', here], required)
    expect([plain.code, plain.stdout, plain.stderr], 'by default the platform it runs on').toEqual([
      named.code, named.stdout, named.stderr,
    ])
    if (here === 'windows') expect(plain.stderr).toContain('hint: to run on windows without it, list the capability')
    const scripted = await cli(['check', '--', '--platform', 'linux'], required)
    expect(scripted.code, 'a leading -- as package manager scripts pass it').toBe(0)
    expect(scripted.stdout).toBe(linux.stdout)

    const optional = project({ type: 'app', id: 'net', capabilities: { network: true }, optional: ['network'] })
    const noted = await cli(['check', '--platform', 'windows'], optional)
    expect(noted.code).toBe(0)
    expect(noted.stderr).toContain('note: windows (desktop): app "net" runs without optional network')
    expect(noted.stderr).not.toContain('error:')
  })

  test('a hand-written package and the apps of a desktop are checked too; an unknown platform is refused', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), 'export default { mount() { return () => {} } }\n')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'cam',
        acde: {
          apiLevel: API_LEVEL,
          apps: [{ id: 'cam', label: 'Cam', icon: 'app', entry: '/ui/app.js', capabilities: { camera: true } }],
          assets: { '/ui/': ['ui'] },
        },
      }),
    )
    const camera = await cli(['check', '--platform', 'windows'], dir)
    expect(camera.code).toBe(1)
    expect(camera.stderr).toContain('error: windows (standalone): app "cam" requires camera, which this mode lacks')
    expect((await cli(['check', '--platform', 'macos'], dir)).code).toBe(0)

    const desk = project({
      type: 'desktop', id: 'desk',
      apps: [{ id: 'net', label: 'Net', entry: 'index.html', backend: false, capabilities: { network: true } }],
    })
    const mac = await cli(['check', '--platform', 'macos'], desk)
    expect(mac.code).toBe(1)
    expect(mac.stderr).toContain('error: macos (desktop): app "net" requires network, which this mode lacks')

    const unknown = await cli(['check', '--platform', 'beos'], desk)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('--platform beos: windows, macos or linux')
  })
})

describe('mistakes', () => {
  test('no index.html', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), '{"name": "empty"}')
    const result = await cli(['build', '--out', join(dir, '.acde')], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no index.html')
  })

  test('an unknown command, argument or count: one line that names the help to read', async () => {
    const lines = (text: string) => text.trim().split('\n')
    const unknown = await cli(['frobnicate'], APP)
    expect(unknown.code).toBe(1)
    expect(lines(unknown.stderr)).toEqual(['acde: unknown command "frobnicate" (acde --help lists the commands)'])
    const argument = await cli(['build', '--bogus'], APP)
    expect(argument.code).toBe(1)
    expect(lines(argument.stderr)).toEqual(['acde: build: unknown argument --bogus (acde build --help)'])
    const value = (await cli(['build', '--out'], APP)).stderr
    expect(lines(value)).toEqual(['acde: build: --out needs a value (acde build --help)'])
    expect(lines((await cli(['eval'], APP)).stderr)).toEqual(['acde: eval: 2 arguments, not 0 (acde eval --help)'])
    const action = await cli(['act', 'w1.2', 'tap'], APP)
    expect(action.code).toBe(1)
    const actions = ACTIONS.join(', ')
    expect(lines(action.stderr)).toEqual([`acde: act: tap is not an action (${actions}) (acde act --help)`])
    expect(ACTIONS).toContain('fill')
    expect(ACTIONS).toContain('fullscreen')
    expect((await cli(['act', '--help'], APP)).stdout.replace(/\s+/g, ' '))
      .toContain('A window ref (w1) also takes close, minimize, restore, fill, fullscreen.')
    const level = lines((await cli(['console', '--level', 'loud'], APP)).stderr)
    const levels = [...Tools.LEVELS].join(', ')
    expect(level).toEqual([`acde: console: --level loud: one of ${levels} (acde console --help)`])
    const nameless = await cli(['new', '--yes'], APP)
    expect(nameless.code).toBe(1)
    const asked = 'acde: new: a directory (or run it in a terminal to be asked) (acde new --help)'
    expect(lines(nameless.stderr)).toEqual([asked])
    const bare = await cli([], APP)
    expect(bare.code).toBe(0)
    expect(lines(bare.stdout)).toEqual([
      expect.stringMatching(/^acde \S+: build, run and test apps for Dopame$/),
      '  acde new my-app   then   cd my-app   then   acde dev',
      'Run acde --help for every command.',
    ])
    expect(bare.stderr).toBe('')
  })

  test('--version: acde, then the SDK and the acdert it finds; --help: all, or one command', async () => {
    const version = await cli(['--version'], APP, { ACDERT: join(tmp(), 'gone') })
    expect(version.code).toBe(0)
    const [acde, sdk] = version.stdout.trim().split('\n')
    expect(acde).toBe(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version)
    const api = join(import.meta.dirname, '..', 'node_modules', '@dopame', 'acde-api', 'package.json')
    expect(sdk).toBe(`sdk ${JSON.parse(readFileSync(api, 'utf8')).version} (contract level ${API_LEVEL})`)
    const s = standIn()
    const found = await cli(['-v'], APP, { ACDERT: s.env['ACDERT']! })
    expect(found.stdout.trim().split('\n')[2]).toBe(`acdert 0.0.0 (contract level ${API_LEVEL}): ${s.env['ACDERT']}`)
    for (const argv of [['--help'], ['help'], ['-h']]) {
      const help = await cli(argv, APP)
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('Usage: acde <command> [options]')
      expect(help.stdout).toMatch(/^Agents:\n {2}mcp +Serve the session tools over MCP \(stdio\)\n {2}skills +Install/m)
      expect(help.stdout).not.toContain('\x1b[')
    }
    for (const argv of [['new', '-h'], ['help', 'new'], ['new', 'x', '--help']]) {
      const help = await cli(argv, APP)
      expect(help.code).toBe(0)
      expect(help.stdout).toStartWith('Usage: acde new [dir] [options]')
      expect(help.stdout).toContain('  --template T  The template: html')
      expect(help.stdout).toContain('Examples:\n  $ acde new my-app')
      expect(help.stdout).not.toContain('acde build')
    }
    expect((await cli(['webs', '--help'], APP)).stdout).toContain('--session PID  The acde dev to use')
    expect((await cli(['--help'], APP, { FORCE_COLOR: '1' })).stdout).toContain('\x1b[1;32mUsage:\x1b[22;39m')
    expect((await cli(['--help'], APP, { FORCE_COLOR: '1', NO_COLOR: '1' })).stdout).not.toContain('\x1b[')
    expect((await cli(['help', 'nope'], APP)).stderr.trim()).toBe(
      'acde: help: unknown command "nope" (acde --help lists the commands)',
    )
  })

  test('help fits the terminal: its width up to 100 columns, 80 when it is not one; indents kept', () => {
    expect([Help.width(undefined), Help.width(60), Help.width(80), Help.width(200), Help.width(20)])
      .toEqual([80, 60, 80, 100, 40])
    expect(Help.terminal({ isTTY: false, columns: 60 })).toBeNull()
    expect(Help.terminal({ isTTY: true, columns: 60 })).toBe(60)
    const commands = Help.commands(['html', 'react'], ACTIONS)
    const plain = Color.palette(false)
    for (const width of [60, 80, 100]) {
      const pages = [
        Help.overview(commands, '0.0.0', plain, width), ...commands.map((c) => Help.command(c, plain, width)),
      ]
      for (const line of pages.flatMap((page) => page.split('\n'))) {
        if (!line.trimStart().startsWith('$ ')) expect(line.length, line).toBeLessThanOrEqual(width)
      }
    }
    const narrow = Help.overview(commands, '0.0.0', plain, 60).split('\n')
    const at = narrow.findIndex((line) => line.startsWith('  -h, --help'))
    expect(narrow[at + 1]).toMatch(/^ {17}\S/)
    expect(Help.command(commands.find((c) => c.name === 'dev')!, plain)).toContain('--verbose')
  })

  test('ids from package names', () => {
    expect(Project.idOf('@scope/My_App')).toBe('my-app')
    expect(Project.idOf('notes')).toBe('notes')
    expect(Project.idOf('@x/--')).toBeNull()
  })
})

describe('acde new when a step fails', () => {
  test('a failed install keeps the project and says how to finish it', async () => {
    const dir = join(tmp(), 'no-deps')
    const made = await cli(['new', dir, '--pm', 'bun', '--yes'], tmp(), { ACDERT_DIST: 'http://127.0.0.1:9' })
    expect(made.code).toBe(1)
    expect(made.stdout).toBe('')
    expect(made.stderr).toStartWith(`acde: the project is in ${dir}, but its dependencies are not installed; `
      + 'once the cause below is fixed, run bun install there: ')
    expect(made.stderr).toMatch(/run bun install there: \S*bun(?:\.exe)? install failed \(exit /)
    expect(existsSync(join(dir, 'acde.config.jsonc'))).toBe(true)
  }, 60_000)
})
