#!/usr/bin/env bun
import { resolve } from 'node:path'
import * as p from '@clack/prompts'
import { Creator, STARTERS } from './create.ts'
import { DevSession } from './dev.ts'
import { AppPackage } from './package.ts'

const USAGE = `usage: acde <command>
  new [dir] [--template T] [--id ID] [--label NAME] [--backend] [--install] [--git] [--yes]
                                                   a project; in a terminal it asks what is missing (--yes: ask nothing)
                                                   T: ${STARTERS.map((s) => s.name).join(', ')}
  check [dir]                                      acde.config.jsonc (or a package's manifest), as acdert reads it
  build [dir] [--out DIR]                          the project into DIR (.acde): its package.json is the manifest
  install [dir] [--out DIR]                        build, then into $XDG_DATA_HOME/acde/packages (a package: a link)
  dev [dir] [--out DIR] [--app ID]                 build, run it in acdert (acdert desktop / app), rebuild and reload on changes`

interface Args {
  readonly command: string
  readonly dir: string
  readonly flags: ReadonlyMap<string, string>
}

class Cli {
  static readonly COMMANDS = new Set(['new', 'check', 'build', 'install', 'dev'])
  static readonly FLAGS = new Set(['out', 'id', 'label', 'app', 'template'])
  static readonly SWITCHES = new Set(['desktop', 'backend', 'install', 'git', 'yes'])

  static parse(argv: readonly string[]): Args {
    const [command = '', ...rest] = argv
    if (!Cli.COMMANDS.has(command)) throw new Error(USAGE)
    const flags = new Map<string, string>()
    const dirs: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      const [flag, inline] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s, 2) : [undefined, undefined]
      if (flag === undefined) dirs.push(arg)
      else if (Cli.SWITCHES.has(flag) && inline === undefined) flags.set(flag, '')
      else if (!Cli.FLAGS.has(flag)) throw new Error(`unknown argument ${arg}\n${USAGE}`)
      else if (inline !== undefined) flags.set(flag, inline)
      else if (rest[i + 1] !== undefined) flags.set(flag, rest[++i]!)
      else throw new Error(`--${flag} needs a value\n${USAGE}`)
    }
    if (dirs.length > 1) throw new Error(USAGE)
    return { command, dir: dirs[0] ?? (command === 'new' ? '' : '.'), flags }
  }

  static async main(argv: readonly string[]): Promise<number> {
    const { command, dir, flags } = Cli.parse(argv)
    if (command === 'new') return await Cli.create(dir, flags)
    const pkg = new AppPackage(dir)
    if (command === 'check') return Cli.report(pkg) ? 0 : 1
    const out = resolve(pkg.dir, flags.get('out') ?? '.acde')
    if (command === 'dev') {
      const acdert = process.env['ACDERT'] || Bun.which('acdert')
      if (!acdert) {
        console.error('acde: no acdert (ACDERT, PATH)')
        return 1
      }
      return await new DevSession(pkg, out, acdert).run(flags.get('app'))
    }
    const built = await pkg.build(out)
    const what = [...built.desktops.map((id) => `desktop ${id}`), ...built.apps.map((id) => `app ${id}`)].join(', ')
    console.log(`acde: ${pkg.project ? `built ${what} into ${built.dir}` : `ok: ${pkg.name} (${what})`}`)
    if (command === 'build') return 0
    console.log(`acde: installed ${built.id} in ${pkg.install(built)}`)
    return 0
  }

  static async create(dir: string, flags: ReadonlyMap<string, string>): Promise<number> {
    const interactive = !flags.has('yes') && process.stdin.isTTY === true && process.stdout.isTTY === true
    if (flags.has('desktop') && flags.has('template') && flags.get('template') !== 'desktop') throw new Error('--desktop and --template: one of them')
    const given = {
      ...(dir && { dir }),
      ...((flags.get('template') ?? (flags.has('desktop') ? 'desktop' : undefined)) !== undefined && { template: flags.get('template') ?? 'desktop' }),
      ...(flags.has('id') && { id: flags.get('id')! }),
      ...(flags.has('label') && { label: flags.get('label')! }),
      ...(flags.has('backend') && { backend: true }),
      ...(flags.has('install') && { install: true }),
      ...(flags.has('git') && { git: true }),
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
    if (!options) return 130
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
