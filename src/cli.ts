#!/usr/bin/env bun
import { resolve } from 'node:path'
import * as p from '@clack/prompts'
import { requireAcdert } from 'acde/launcher'
import { Creator, STARTERS } from './create.ts'
import { DevSession } from './dev.ts'
import { TestRunner } from './e2e/runner.ts'
import { Mcp } from './mcp.ts'
import { PackageManager } from './pm.ts'
import { AppPackage } from './package.ts'
import { Tools } from './tools.ts'

const USAGE = `usage: acde <command>
  new [dir] [--template T] [--id ID] [--label NAME] [--backend] [--install] [--git] [--pm PM] [--yes]
                                                   a project; in a terminal it asks what is missing (--yes: ask nothing)
                                                   T: ${STARTERS.map((s) => s.name).join(', ')}; PM: bun, npm, pnpm, yarn (default: the one running this)
  check [dir]                                      acde.config.jsonc (or a package's manifest), as acdert reads it
  build [dir] [--out DIR]                          the project into DIR (.acde): its package.json is the manifest
  install [dir] [--out DIR]                        build, then into $XDG_DATA_HOME/acde/packages (a package: a link)
  dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless]
                                                   build, run in acdert, rebuild and reload what changed; one project: its
                                                   desktop or app; several or --desktop: all in that desktop (default: the
                                                   desktop project among them, else dopame); --headless: no host window
 with an acde dev running (the one whose projects hold this directory, or --session PID):
  webs                                             the webs (windows' pages) acdert runs
  eval <web> <code|->                              evaluate code in a web (a web name, an app id or desktop), print the JSON
  shot <web> [-o FILE]                             a PNG of the web's window (default ./<web>.png), print its path
  inspect [--window W] [--find TEXT] [--all] [--offscreen]
                                                   the desktop as text (acde:inspect snapshot); --offscreen: scrolled-out too
  act <ref> <action> [arg]                         click / type / key … on a ref from inspect, print what changed
  console [--web W] [--level L] [--follow]         pages' console.* and uncaught errors (L: log info warn error debug errors)
  network [--web W] [--failed] [--follow]          pages' fetch / XHR / WebSocket / EventSource requests and how they ended
  screen [-o FILE]                                 a PNG of the whole screen, every window composed (default ./screen.png)
  test [dir|file...] [--headed] [-t PATTERN] [--desktop ID|DIR] [--timeout MS] [--bail]
                                                   run the e2e tests (*.e2e.ts, import from acde/test): each test gets a fresh,
                                                   isolated acde dev (headless unless --headed); what a failing test left goes
                                                   to <project>/.acde/test-results
  mcp [--session PID]                              an MCP server on stdio with these tools (and start / logs: run acde dev itself);
                                                   for agents: claude mcp add acde -- acde mcp`

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
    check: { args: [0, 1] },
    build: { args: [0, 1], flags: ['out'] },
    install: { args: [0, 1], flags: ['out'] },
    dev: { args: [0, Infinity], flags: ['out', 'app', 'desktop'], switches: ['headless'] },
    webs: { args: [0, 0], flags: ['session'] },
    eval: { args: [2, 2], flags: ['session'] },
    shot: { args: [1, 1], flags: ['session', 'output'] },
    inspect: { args: [0, 0], flags: ['session', 'window', 'find'], switches: ['all', 'offscreen'] },
    act: { args: [2, 3], flags: ['session'] },
    console: { args: [0, 0], flags: ['session', 'web', 'level'], switches: ['follow'] },
    network: { args: [0, 0], flags: ['session', 'web'], switches: ['follow', 'failed'] },
    screen: { args: [0, 0], flags: ['session', 'output'] },
    mcp: { args: [0, 0], flags: ['session'] },
    test: { args: [0, Infinity], flags: ['desktop', 'test-name-pattern', 'timeout'], switches: ['headed', 'bail'] },
  }
  static readonly SHORT: Readonly<Record<string, string>> = { o: 'output', t: 'test-name-pattern' }

  static parse(argv: readonly string[]): Args {
    const [command = '', ...rest] = argv
    const spec = Object.hasOwn(Cli.SPECS, command) ? Cli.SPECS[command]! : null
    if (!spec) throw new Error(USAGE)
    const flags = new Map<string, string>()
    const args: string[] = []
    let positional = false
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      if (positional || arg === '-' || !arg.startsWith('-') || (/^-[^-]/.test(arg) && !Object.hasOwn(Cli.SHORT, arg.slice(1)))) {
        args.push(arg)
        continue
      }
      if (arg === '--') {
        positional = true
        continue
      }
      const [flag, inline] = arg.startsWith('--') ? (arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]) : [Cli.SHORT[arg.slice(1)]!, undefined]
      if (spec.switches?.includes(flag) && inline === undefined) flags.set(flag, '')
      else if (!spec.flags?.includes(flag)) throw new Error(`${command}: unknown argument ${arg}\n${USAGE}`)
      else if (inline !== undefined) flags.set(flag, inline)
      else if (rest[i + 1] !== undefined) flags.set(flag, rest[++i]!)
      else throw new Error(`--${flag} needs a value\n${USAGE}`)
    }
    const [min, max] = spec.args
    if (args.length < min || args.length > max) throw new Error(`${command}: ${min === max ? min : `${min} to ${max}`} arguments, not ${args.length}\n${USAGE}`)
    return { command, args, flags }
  }

  static async main(argv: readonly string[]): Promise<number> {
    const { command, args, flags } = Cli.parse(argv)
    if (Tools.COMMANDS.has(command)) return await Tools.run(command, args, flags)
    if (command === 'test') {
      const timeout = flags.has('timeout') ? Number(flags.get('timeout')) : undefined
      if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) throw new Error(`--timeout ${flags.get('timeout')}: milliseconds per test`)
      return await TestRunner.run({
        targets: args,
        ...(flags.has('desktop') && { desktop: flags.get('desktop')! }),
        ...(flags.has('headed') && { headed: true }),
        ...(flags.has('bail') && { bail: true }),
        ...(flags.has('test-name-pattern') && { pattern: flags.get('test-name-pattern')! }),
        ...(timeout !== undefined && { timeout }),
      })
    }
    if (command === 'mcp') return await Mcp.serve(flags.has('session') ? { session: Tools.pid(flags.get('session')!) } : {})
    if (command === 'new') return await Cli.create(args[0] ?? '', flags)
    if (command === 'dev') {
      const session = new DevSession({ dirs: args, ...(flags.has('out') && { out: flags.get('out')! }), ...(flags.has('app') && { app: flags.get('app')! }), ...(flags.has('desktop') && { desktop: flags.get('desktop')! }), ...(flags.has('headless') && { headless: true }), acdert: await requireAcdert() })
      return await session.run()
    }
    const pkg = new AppPackage(args[0] ?? '.')
    if (command === 'check') return Cli.report(pkg) ? 0 : 1
    const built = await pkg.build(resolve(pkg.dir, flags.get('out') ?? '.acde'))
    const what = [...built.desktops.map((id) => `desktop ${id}`), ...built.apps.map((id) => `app ${id}`)].join(', ')
    console.log(`acde: ${pkg.project ? `built ${what} into ${built.dir}` : `ok: ${pkg.name} (${what})`}`)
    if (command === 'build') return 0
    console.log(`acde: installed ${built.id} in ${pkg.install(built)}`)
    return 0
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
      if (!given.dir) throw new Error(`new: a directory (or run it in a terminal to be asked)\n${USAGE}`)
      const created = await Creator.create(given, false)
      Cli.report(created.pkg)
      console.log(`acde: ${created.starter.label} in ${created.pkg.dir}. next: ${Creator.next(created).join(' && ')}`)
      return 0
    }
    const options = await Creator.ask(given)
    if (!options) return 0
    const created = await Creator.create(options, true)
    const { errors, warnings } = created.pkg.check()
    for (const warning of warnings) p.log.warn(warning)
    for (const error of errors) p.log.error(error)
    p.note(Creator.next(created).join('\n'), 'Next')
    p.outro(`${created.starter.kind === 'desktop' ? 'Desktop' : `${created.starter.label} app`} ${JSON.stringify(created.pkg.name)} is ready`)
    return errors.length === 0 ? 0 : 1
  }

  static report(pkg: AppPackage): boolean {
    const { errors, warnings } = pkg.check()
    for (const warning of warnings) console.error(`warning: ${warning}`)
    for (const error of errors) console.error(`error: ${error}`)
    if (errors.length === 0) console.log(`ok: ${pkg.name}, ${pkg.kind}`)
    return errors.length === 0
  }
}

try {
  process.exitCode = await Cli.main(process.argv.slice(2))
} catch (error) {
  console.error(`acde: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
