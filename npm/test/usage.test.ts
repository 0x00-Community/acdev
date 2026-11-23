import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { API_LEVEL, platformSupport, RUNNING_MODES } from '../src/manifest/index.ts'
import { Project } from '../src/app.ts'
import { Color } from '../src/color.ts'
import { ACTIONS } from '../src/driver/acde.ts'
import { Help } from '../src/help.ts'
import { AppPackage } from '../src/package.ts'
import { Tools } from '../src/tools.ts'
import { brokenSdk, cleanup, collect, env, standIn, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const APP = join(import.meta.dir, 'fixtures/app')

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

afterAll(cleanup)

describe('acdev check --platform', () => {
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
          apps: [{ id: 'cam', label: 'Cam', icon: 'application-x-executable', entry: '/ui/app.js', capabilities: { camera: true } }],
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
    expect(unknown.stderr).toBe('acdev: check: --platform beos: windows, macos, linux (acdev check --help)\n')
    expect(() => new AppPackage(desk).platform('beos')).toThrow(
      'check: --platform beos: windows, macos, linux (acdev check --help)')
  })
})

describe('option errors', () => {
  test('--out that holds the project names the command that was given it', async () => {
    const dir = realpathSync(tmp())
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'outs' }))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    const holds = 'a directory that does not hold the project (acdev empties it before each build)'
    for (const command of ['build', 'install']) {
      const ran = await cli([command, '--out', '.'], dir)
      expect(ran.code).toBe(1)
      expect(ran.stderr).toBe(`acdev: ${command}: --out ${dir}: ${holds} (acdev ${command} --help)\n`)
    }
    await expect(new AppPackage(dir).build(dirname(dir), { dev: true })).rejects.toThrow(
      `dev: --out ${dirname(dir)}: ${holds} (acdev dev --help)`)
    expect(existsSync(join(dir, 'index.html'))).toBe(true)
  })

  test('open tells an app from a path and a link, and keeps guest paths absolute', () => {
    expect(Tools.opening(['files'])).toEqual({ name: 'files' })
    expect(Tools.opening(['/home/u/a/b'])).toEqual({ path: '/home/u/a/b' })
    expect(Tools.opening(['./notes.md'])).toEqual({ path: './notes.md' })
    expect(Tools.opening(['https://example.com'])).toEqual({ url: 'https://example.com' })
    expect(Tools.opening(['files', '/home/u/a'])).toEqual({ name: 'files', path: '/home/u/a' })
    expect(Tools.opening(['web', 'http://x.test'])).toEqual({ name: 'web', url: 'http://x.test' })
    expect(() => Tools.opening(['/a', '/b'])).toThrow('open: /a is not an app')
    expect(Tools.located({ path: 'a/b.md' }, false, '/base')).toEqual({ path: resolve('/base', 'a/b.md') })
    expect(() => Tools.located({ path: 'a/b.md' }, true)).toThrow('a path in the guest is absolute')
    expect(() => Tools.located({ url: 'ftp://x' }, false)).toThrow('only http and https')
  })

  test('shot and screen take --ref or --rect, not both, and say what each looks like', () => {
    const given = (pairs: Record<string, string>) => new Map(Object.entries(pairs))
    expect(Tools.region('shot', given({}))).toBeNull()
    expect(Tools.region('shot', given({ ref: 'w3.12' }))).toEqual({ ref: 'w3.12' })
    expect(Tools.region('screen', given({ ref: 'w0' }))).toEqual({ ref: 'w0' })
    expect(Tools.region('screen', given({ rect: '0,0,400,48' }))).toEqual({ rect: [0, 0, 400, 48] })
    expect(() => Tools.region('shot', given({ ref: 'w1.2', rect: '0,0,1,1' }))).toThrow('shot: give --ref or --rect, not both')
    expect(() => Tools.region('shot', given({ ref: 'button' }))).toThrow('shot: --ref button: an element or window ref')
    expect(() => Tools.region('screen', given({ rect: '0,0,0,4' }))).toThrow('screen: --rect 0,0,0,4: X,Y,W,H in logical pixels')
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
    expect(lines(unknown.stderr)).toEqual(['acdev: unknown command "frobnicate" (acdev --help lists the commands)'])
    const argument = await cli(['build', '--bogus'], APP)
    expect(argument.code).toBe(1)
    expect(lines(argument.stderr)).toEqual(['acdev: build: unknown argument --bogus (acdev build --help)'])
    const value = (await cli(['build', '--out'], APP)).stderr
    expect(lines(value)).toEqual(['acdev: build: --out needs a value (acdev build --help)'])
    expect(lines((await cli(['eval'], APP)).stderr)).toEqual(['acdev: eval: 2 arguments, not 0 (acdev eval --help)'])
    const action = await cli(['act', 'w1.2', 'tap'], APP)
    expect(action.code).toBe(1)
    const actions = ACTIONS.join(', ')
    expect(lines(action.stderr)).toEqual([`acdev: act: tap is not an action (${actions}) (acdev act --help)`])
    const input = await cli(['input', 'notes', '{"type":"move"}'], APP)
    expect(input.code).toBe(1)
    expect(lines(input.stderr)).toEqual(['acdev: input: the events are a non-empty JSON array of objects with a type (acdev input --help)'])
    expect(lines((await cli(['input', 'notes', 'nope'], APP)).stderr)[0]).toStartWith('acdev: input: the events are a JSON array (')
    expect((await cli(['input', '--help'], APP)).stdout.replace(/\s+/g, ' ')).toContain('keydown, wait, keyup holds a key.')
    expect(ACTIONS).toEqual(expect.arrayContaining(['fill', 'fullscreen', 'move', 'resize', 'raise']))
    const actHelp = (await cli(['act', '--help'], APP)).stdout.replace(/\s+/g, ' ')
    expect(actHelp)
      .toContain('A window ref (w1) also takes close, minimize, restore, fill, fullscreen, move, resize, raise.')
    expect(actHelp).toContain('acdev act w1 move 100,80')
    expect(actHelp).toContain('to put a window at an exact place use move')
    expect(lines((await cli(['act', 'w1', 'move'], APP)).stderr))
      .toEqual(['acdev: act: move needs where to, in screen x,y: acdev act w1 move 100,80'])
    expect(lines((await cli(['act', 'w1', 'resize'], APP)).stderr))
      .toEqual(['acdev: act: resize needs the size, WxH: acdev act w1 resize 800x600'])
    const level = lines((await cli(['console', '--level', 'loud'], APP)).stderr)
    const levels = [...Tools.LEVELS].join(', ')
    expect(level).toEqual([`acdev: console: --level loud: one of ${levels} (acdev console --help)`])
    const shaped: [string[], string][] = [
      [['test', '--timeout', 'x'], 'acdev: test: --timeout x: milliseconds per test, 1 or more (acdev test --help)'],
      [['test', '--workers', '0'], 'acdev: test: --workers 0: how many test files run at once, 1 or more '
        + '(acdev test --help)'],
      [['test', '--retries', '-1'], 'acdev: test: --retries -1: how often to run a failing test again, 0 or more '
        + '(acdev test --help)'],
      [['test', '--video=sometimes'], 'acdev: test: --video sometimes: failed (the default: only for failing tests), '
        + 'on or off (acdev test --help)'],
      [['webs', '--session', 'abc'], 'acdev: webs: --session abc: the process id of an acdev dev, or vm for the session '
        + 'in the guest of acdev vm (acdev webs --help)'],
      [['devtools', '--session', 'abc'], 'acdev: devtools: --session abc: the process id of an acdev dev, or vm for the '
        + 'session in the guest of acdev vm (acdev devtools --help)'],
      [['query', 'p', '--limit', 'x'], 'acdev: query: --limit x: how many elements to list at most, 1 to 3000 '
        + '(acdev query --help)'],
    ]
    for (const [argv, said] of shaped) {
      const ran = await cli(argv, APP)
      expect(ran.code, argv.join(' ')).toBe(1)
      expect(lines(ran.stderr)).toEqual([said])
    }
    const nameless = await cli(['new', '--yes'], APP)
    expect(nameless.code).toBe(1)
    const asked = 'acdev: new: a directory (or run it in a terminal to be asked) (acdev new --help)'
    expect(lines(nameless.stderr)).toEqual([asked])
    const bare = await cli([], APP)
    expect(bare.code).toBe(0)
    expect(lines(bare.stdout)).toEqual([
      expect.stringMatching(/^acdev \S+: build, run and test apps for Dopame$/),
      '  acdev new my-app   then   cd my-app   then   acdev dev',
      'Run acdev --help for every command.',
    ])
    expect(bare.stderr).toBe('')
  })

  test('--version: acde, then the SDK and the acdert it finds; --help: all, or one command', async () => {
    const version = await cli(['--version'], APP, { ACDEV_RUNTIME: join(tmp(), 'gone') })
    expect(version.code).toBe(0)
    const [acde, sdk] = version.stdout.trim().split('\n')
    expect(acde).toBe(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version)
    const api = join(import.meta.dirname, '..', 'node_modules', '@acde', 'api', 'package.json')
    expect(sdk).toBe(`sdk ${JSON.parse(readFileSync(api, 'utf8')).version} (contract level ${API_LEVEL})`)
    const s = standIn()
    const found = await cli(['-v'], APP, { ACDEV_RUNTIME: s.env['ACDEV_RUNTIME']! })
    expect(found.stdout.trim().split('\n')[2]).toBe(`acdert 0.0.0 (contract level ${API_LEVEL}): ${s.env['ACDEV_RUNTIME']}`)
    for (const argv of [['--help'], ['help'], ['-h']]) {
      const help = await cli(argv, APP)
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('Usage: acdev <command> [options]')
      expect(help.stdout).toMatch(/^Agents:\n {2}mcp +Serve the session tools over MCP \(stdio\)\n {2}skills +Install/m)
      expect(help.stdout).not.toContain('\x1b[')
    }
    for (const argv of [['new', '-h'], ['help', 'new'], ['new', 'x', '--help']]) {
      const help = await cli(argv, APP)
      expect(help.code).toBe(0)
      expect(help.stdout).toStartWith('Usage: acdev new [dir] [options]')
      expect(help.stdout).toContain('  --template T  The template: html')
      expect(help.stdout).toContain('Examples:\n  $ acdev new my-app')
      expect(help.stdout).not.toContain('acdev build')
    }
    expect((await cli(['webs', '--help'], APP)).stdout).toContain('--session PID|vm  The acdev dev to use')
    expect((await cli(['--help'], APP, { FORCE_COLOR: '1' })).stdout).toContain('\x1b[1;32mUsage:\x1b[22;39m')
    expect((await cli(['--help'], APP, { FORCE_COLOR: '1', NO_COLOR: '1' })).stdout).not.toContain('\x1b[')
    expect((await cli(['help', 'nope'], APP)).stderr.trim()).toBe(
      'acdev: help: unknown command "nope" (acdev --help lists the commands)',
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
    expect(Help.wrap('记账 应用 已经 启动 然后 重新 加载 页面', 20, '  ')).toEqual([
      '  记账 应用 已经',
      '  启动 然后 重新',
      '  加载 页面',
    ])
    expect(Help.block(['/Users/张三/项目/记账', '(Claude', 'Code)'], 30, '    ', 'link  ')).toEqual([
      'link  /Users/张三/项目/记账',
      '    (Claude Code)',
    ])
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

describe('acdev new when a step fails', () => {
  test('a failed install keeps the project and says how to finish it', async () => {
    const dir = join(tmp(), 'no-deps')
    const made = await cli(['new', dir, '--pm', 'bun', '--yes'], tmp(), { ACDEV_SDK: brokenSdk() })
    expect(made.code).toBe(1)
    expect(made.stdout).toBe('')
    expect(made.stderr).toStartWith(`acdev: the project is in ${dir}, but its dependencies are not installed; `
      + 'once the cause below is fixed, run bun install there: ')
    expect(made.stderr).toMatch(/run bun install there: \S*bun(?:\.exe)? install failed \(exit /)
    expect(existsSync(join(dir, 'acde.config.jsonc'))).toBe(true)
  }, 60_000)
})
