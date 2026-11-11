#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as p from '@clack/prompts'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { packageRoot, requireAcdert, run, runtimes } from 'acde/launcher'
import { Creator, STARTERS } from './create.ts'
import { DevSession } from './dev.ts'
import { TestRunner } from './e2e/runner.ts'
import { Mcp } from './mcp.ts'
import { PackageManager } from './pm.ts'
import { AppPackage } from './package.ts'
import { Runtime } from './runtime.ts'
import { Skills } from './skills.ts'
import { Tools } from './tools.ts'

declare const ACDE_SDK_VERSION: string | undefined

const USAGE = `usage: acde <command>
  new [dir] [--template T] [--id ID] [--label NAME] [--backend] [--install] [--git] [--pm PM] [--yes]
                                                   a project; in a terminal it asks what is missing (--yes: ask nothing)
                                                   T: ${STARTERS.map((s) => s.name).join(', ')}
                                                   PM: bun, npm, pnpm, yarn (default: the one running this)
  check [dir] [--platform P]                       acde.config.jsonc (or a package's manifest), as acdert reads it;
                                                   P (windows, macos, linux; default: this one): the required
                                                   capabilities a running mode there lacks (optional ones are notes)
  build [dir] [--out DIR]                          the project into DIR (.acde): its package.json is the manifest
  install [dir] [--out DIR]                        build, then into $XDG_DATA_HOME/acde/packages (a package: a link);
                                                   default ~/.local/share/acde/packages, on Windows
                                                   %USERPROFILE%\\.local\\share\\acde\\packages
  dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless]
                                                   build, run in acdert, rebuild and reload what changed; one
                                                   project: its desktop or app; several or --desktop: all in that
                                                   desktop (default: the desktop project among them, else dopame);
                                                   --headless: no host window
 with an acde dev running (the one whose projects hold this directory, or --session PID):
  webs                                             the webs (windows' pages) acdert runs
  eval <web> <code|->                              evaluate code in a web (a web name, an app id or desktop),
                                                   print the JSON
  shot <web> [-o FILE]                             a PNG of the web's window (default ./<web>.png), print its path
  inspect [--window W] [--find TEXT] [--all] [--offscreen]
                                                   the desktop as text (acde:inspect snapshot);
                                                   --offscreen: scrolled-out too; --all: every window, and
                                                   elements hidden by opacity: 0 or visibility
  act <ref> <action> [arg]                         click / type / key … on a ref from inspect, print what changed
  console [--web W] [--level L] [--since S] [--follow]
                                                   pages' console.* and uncaught errors
                                                   (L: log info warn error debug errors; S: reload, entries since
                                                   acde dev last reloaded, or N, from entry N on)
  network [--web W] [--failed] [--since S] [--follow]
                                                   pages' fetch / XHR / WebSocket / EventSource requests
                                                   and the images, stylesheets and fonts they load, and how they ended
  screen [-o FILE]                                 a PNG of the whole screen, every window composed
                                                   (default ./screen.png)
  pointer <x> <y>                                  move the pointer to screen coordinates, as a real move
                                                   (hover, screen edges); host window: its content area
  stop                                             end that acde dev and its acdert (as closing its last window
                                                   does); for one started in the background
  test [dir|file...] [--headed] [-t PATTERN] [--desktop ID|DIR] [--timeout MS] [--bail] [--trace] [-u]
                                                   run the e2e tests (*.e2e.ts, import from acde/test): each test
                                                   gets a fresh, isolated acde dev (headless unless --headed); what a
                                                   failing test left goes to <project>/.acde/test-results (--trace: a
                                                   screenshot after every step and trace.html for every test);
                                                   -u / --update-screenshots rewrites the baselines
  mcp [--session PID]                              an MCP server on stdio with these tools (and start / logs: run
                                                   acde dev itself); for agents: claude mcp add acde -- acde mcp
 for coding agents:
  skills [install|remove|path] [--agent ID,...] [--dir DIR] [--copy]
                                                   the acde skill (how to build, run, inspect and test with acde,
                                                   in the Agent Skills format): where it is installed; install links
                                                   it into ~/.agents/skills and the skills directory of every agent
                                                   found here (--agent: of those agents; --dir: into DIR; --copy: a
                                                   copy, not a link); remove; path prints its directory
 --version, -v                                     the version of acde, then the SDK and the acdert it finds
 --help, -h                                        this; after a command (or help <command>), that command only`

interface Spec {
  readonly args: readonly [number, number]
  readonly flags?: readonly string[]
  readonly switches?: readonly string[]
}

interface Args {
  readonly command: string
  readonly args: readonly string[]
  readonly flags: ReadonlyMap<string, string>
}

class Cli {
  static readonly SPECS: Readonly<Record<string, Spec>> = {
    new: { args: [0, 1], flags: ['id', 'label', 'template', 'pm'], switches: ['backend', 'install', 'git', 'yes'] },
    check: { args: [0, 1], flags: ['platform'] },
    build: { args: [0, 1], flags: ['out'] },
    install: { args: [0, 1], flags: ['out'] },
    dev: { args: [0, Infinity], flags: ['out', 'app', 'desktop'], switches: ['headless'] },
    webs: { args: [0, 0], flags: ['session'] },
    eval: { args: [2, 2], flags: ['session'] },
    shot: { args: [1, 1], flags: ['session', 'output'] },
    inspect: { args: [0, 0], flags: ['session', 'window', 'find'], switches: ['all', 'offscreen'] },
    act: { args: [2, 3], flags: ['session'] },
    console: { args: [0, 0], flags: ['session', 'web', 'level', 'since'], switches: ['follow'] },
    network: { args: [0, 0], flags: ['session', 'web', 'since'], switches: ['follow', 'failed'] },
    screen: { args: [0, 0], flags: ['session', 'output'] },
    pointer: { args: [2, 2], flags: ['session'] },
    stop: { args: [0, 0], flags: ['session'] },
    mcp: { args: [0, 0], flags: ['session'] },
    skills: { args: [0, 1], flags: ['agent', 'dir'], switches: ['copy'] },
    test: {
      args: [0, Infinity],
      flags: ['desktop', 'test-name-pattern', 'timeout'],
      switches: ['headed', 'bail', 'trace', 'update-screenshots'],
    },
  }
  static readonly SHORT: Readonly<Record<string, string>> = {
    o: 'output', t: 'test-name-pattern', u: 'update-screenshots',
  }

  static parse(argv: readonly string[]): Args {
    const [command = '', ...rest] = argv
    const spec = Object.hasOwn(Cli.SPECS, command) ? Cli.SPECS[command]! : null
    if (!command) throw new Error(USAGE)
    if (!spec) throw new Error(`unknown command ${JSON.stringify(command)} (acde --help lists the commands)`)
    const hint = `(acde ${command} --help)`
    const flags = new Map<string, string>()
    const args: string[] = []
    let positional = false
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      const unknownShort = /^-[^-]/.test(arg) && !Object.hasOwn(Cli.SHORT, arg.slice(1))
      if (positional || arg === '-' || !arg.startsWith('-') || unknownShort) {
        args.push(arg)
        continue
      }
      if (arg === '--') {
        positional = i > 0
        continue
      }
      const [flag, inline] = arg.startsWith('--')
        ? (arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined])
        : [Cli.SHORT[arg.slice(1)]!, undefined]
      if (spec.switches?.includes(flag) && inline === undefined) flags.set(flag, '')
      else if (!spec.flags?.includes(flag)) throw new Error(`${command}: unknown argument ${arg} ${hint}`)
      else if (inline !== undefined) flags.set(flag, inline)
      else if (rest[i + 1] !== undefined) flags.set(flag, rest[++i]!)
      else throw new Error(`${command}: --${flag} needs a value ${hint}`)
    }
    const [min, max] = spec.args
    if (args.length < min || args.length > max) {
      const count = min === max ? min : max === Infinity ? `${min} or more` : `${min} to ${max}`
      throw new Error(`${command}: ${count} arguments, not ${args.length} ${hint}`)
    }
    return { command, args, flags }
  }

  static usage(command: string): string {
    if (!command) return USAGE
    if (!Object.hasOwn(Cli.SPECS, command))
      throw new Error(`help: unknown command ${JSON.stringify(command)} (acde --help lists the commands)`)
    const lines = USAGE.split('\n')
    const at = lines.findIndex((line) => line === `  ${command}` || line.startsWith(`  ${command} `))
    const [syntax = '', said] = lines[at]!.trim().split(/ {2,}(.*)/s, 2)
    const about = said ? [said] : []
    for (let i = at + 1; i < lines.length && /^ {20,}\S/.test(lines[i]!); i++) about.push(lines[i]!.trim())
    if (Tools.COMMANDS.has(command))
      about.push('--session PID: the acde dev to use (default: the one whose projects hold this directory)')
    return [`usage: acde ${syntax}`, ...about.map((line) => `  ${line}`)].join('\n')
  }

  static async versions(): Promise<string[]> {
    const lines = [Mcp.version(), `sdk ${Cli.sdk()} (contract level ${API_LEVEL})`]
    let acdert: string
    try {
      acdert = requireAcdert()
    } catch {
      return [...lines, 'acdert: not found (ACDERT, next to acde, PATH)']
    }
    const { said } = await DevSession.runtimeLevel(acdert)
    const named = said.split(/\r?\n/).map((line) => line.trim())
      .find((line) => /^acdert \S+ \(contract level \d+\)$/.test(line))
    return [...lines, named ? `${named}: ${acdert}` : `acdert without a contract level (older, level 0): ${acdert}`]
  }

  static sdk(): string {
    if (typeof ACDE_SDK_VERSION === 'string') return ACDE_SDK_VERSION
    const file = join(packageRoot(), 'node_modules', '@dopame', 'acde-api', 'package.json')
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
    } catch {
      return 'unknown'
    }
  }

  static async main(argv: readonly string[]): Promise<number> {
    const [first = ''] = argv
    if (argv.length === 0) {
      console.log(`acde ${Mcp.version()}: acde --help lists the commands`)
      return 0
    }
    if (['--version', '-v', 'version'].includes(first)) {
      for (const line of await Cli.versions()) console.log(line)
      return 0
    }
    const end = argv.indexOf('--')
    const asked = (end < 0 ? argv : argv.slice(0, end)).some((arg) => arg === '--help' || arg === '-h')
    if (first === 'help' || (asked && (first.startsWith('-') || Object.hasOwn(Cli.SPECS, first)))) {
      const topic = first === 'help' ? (argv[1] ?? '') : first.startsWith('-') ? '' : first
      console.log(Cli.usage(topic))
      return 0
    }
    const { command, args, flags } = Cli.parse(argv)
    if (Tools.COMMANDS.has(command)) return await Tools.run(command, args, flags)
    const followed = await Cli.follow(command, args[0] ?? '.', argv)
    if (followed !== null) return followed
    if (command === 'test') {
      const timeout = flags.has('timeout') ? Number(flags.get('timeout')) : undefined
      if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
        throw new Error(`--timeout ${flags.get('timeout')}: milliseconds per test`)
      return await TestRunner.run({
        targets: args,
        ...(flags.has('desktop') && { desktop: flags.get('desktop')! }),
        ...(flags.has('headed') && { headed: true }),
        ...(flags.has('bail') && { bail: true }),
        ...(flags.has('trace') && { trace: true }),
        ...(flags.has('update-screenshots') && { update: true }),
        ...(flags.has('test-name-pattern') && { pattern: flags.get('test-name-pattern')! }),
        ...(timeout !== undefined && { timeout }),
      })
    }
    if (command === 'skills') return Skills.run(args, flags)
    if (command === 'mcp')
      return await Mcp.serve(flags.has('session') ? { session: Tools.pid(flags.get('session')!) } : {})
    if (command === 'new') return await Cli.create(args[0] ?? '', flags)
    if (command === 'dev') {
      const session = new DevSession({
        dirs: args,
        ...(flags.has('out') && { out: flags.get('out')! }),
        ...(flags.has('app') && { app: flags.get('app')! }),
        ...(flags.has('desktop') && { desktop: flags.get('desktop')! }),
        ...(flags.has('headless') && { headless: true }),
        acdert: await requireAcdert(),
      })
      return await session.run()
    }
    const pkg = new AppPackage(args[0] ?? '.')
    if (command === 'check') return Cli.report(pkg, flags.get('platform') ?? AppPackage.here()) ? 0 : 1
    const built = await pkg.build(resolve(pkg.dir, flags.get('out') ?? '.acde'))
    const what = [...built.desktops.map((id) => `desktop ${id}`), ...built.apps.map((id) => `app ${id}`)].join(', ')
    console.log(`acde: ${pkg.project ? `built ${what} into ${built.dir}` : `ok: ${pkg.name} (${what})`}`)
    if (command === 'build') return 0
    console.log(`acde: installed ${built.id} in ${pkg.install(built)}`)
    return 0
  }

  static async follow(command: string, dir: string, argv: readonly string[]): Promise<number | null> {
    const bundled = import.meta.url.endsWith('.js')
    if (!['dev', 'build', 'install'].includes(command) || !bundled || process.env['ACDE_FOLLOWED']) return null
    const wanted = PackageManager.of(resolve(dir)).runtime
    const current = Runtime.bun ? 'bun' : 'node'
    if (wanted === current) return null
    const exe = runtimes()[wanted]
    if (exe) {
      process.env['ACDE_FOLLOWED'] = '1'
      return await run(argv, exe)
    }
    const needed = wanted === 'bun' ? 'Bun 1.4+' : 'Node.js 22.3+'
    const using = current === 'bun' ? 'Bun' : 'Node.js'
    console.error(`acde: this project runs on ${needed}, which is not on PATH: going on with ${using}`)
    return null
  }

  static async create(dir: string, flags: ReadonlyMap<string, string>): Promise<number> {
    const interactive = !flags.has('yes') && process.stdin.isTTY === true && process.stdout.isTTY === true
    const given = {
      ...(dir && { dir }),
      ...(flags.has('template') && { template: flags.get('template')! }),
      ...(flags.has('id') && { id: flags.get('id')! }),
      ...(flags.has('label') && { label: flags.get('label')! }),
      ...(flags.has('backend') && { backend: true }),
      ...(flags.has('install') && { install: true }),
      ...(flags.has('git') && { git: true }),
      ...(flags.has('pm') && { pm: PackageManager.named(flags.get('pm')!).name }),
    }
    if (given.template !== undefined) Creator.starter(given.template)
    if (!interactive) {
      if (!given.dir) throw new Error('new: a directory (or run it in a terminal to be asked) (acde new --help)')
      const created = await Creator.create(given, false)
      Cli.report(created.pkg)
      console.log(`acde: ${created.starter.label} in ${created.pkg.dir}. next: ${Creator.next(created).join(' && ')}`)
      console.log(`acde: then: ${Creator.LATER.join('; ')}`)
      return 0
    }
    const options = await Creator.ask(given)
    if (!options) return 0
    const created = await Creator.create(options, true)
    const { errors, warnings } = created.pkg.check()
    for (const warning of warnings) p.log.warn(warning)
    for (const error of errors) p.log.error(error)
    p.note(Creator.next(created).join('\n'), 'Next')
    p.note(Creator.LATER.join('\n'), 'Then')
    const kind = created.starter.kind === 'desktop' ? 'Desktop' : `${created.starter.label} app`
    p.outro(`${kind} ${JSON.stringify(created.pkg.name)} is ready`)
    return errors.length === 0 ? 0 : 1
  }

  static report(pkg: AppPackage, platform = AppPackage.here()): boolean {
    const target = platform === null ? null : pkg.platform(platform)
    const { errors, warnings } = pkg.check()
    for (const warning of warnings) console.error(`warning: ${warning}`)
    for (const error of errors) console.error(`error: ${error}`)
    if (errors.length === 0) console.log(`ok: ${pkg.name}, ${pkg.kind}`)
    if (!target) return errors.length === 0
    for (const note of target.notes) console.error(`note: ${note}`)
    for (const error of target.errors) console.error(`error: ${error}`)
    if (target.errors.length > 0) {
      console.error(`hint: to run on ${platform} without it, list the capability in "optional" and import it with `
        + `load('<name>') from @dopame/acde-api`)
    }
    const modes = `${platform} (${target.modes.join(', ')})`
    if (target.errors.length === 0) console.log(`ok: ${modes}: every required capability is there`)
    return errors.length === 0 && target.errors.length === 0
  }
}

try {
  process.exitCode = await Cli.main(process.argv.slice(2))
} catch (error) {
  console.error(`acde: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
