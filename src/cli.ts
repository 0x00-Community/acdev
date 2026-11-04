#!/usr/bin/env bun
import { resolve } from 'node:path'
import { DevSession } from './dev.ts'
import { AppPackage } from './package.ts'

const USAGE = `usage: acde <command>
  new <dir> [--desktop] [--id ID] [--label NAME]   a project: acde.config.jsonc ("type": "app", or "desktop")
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
  static readonly FLAGS = new Set(['out', 'id', 'label', 'app'])
  static readonly SWITCHES = new Set(['desktop'])

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
    if (dirs.length > 1 || (command === 'new' && dirs.length === 0)) throw new Error(USAGE)
    return { command, dir: dirs[0] ?? '.', flags }
  }

  static async main(argv: readonly string[]): Promise<number> {
    const { command, dir, flags } = Cli.parse(argv)
    if (command === 'new') {
      const pkg = AppPackage.create(dir, flags.has('desktop') ? 'desktop' : 'app', flags.get('id'), flags.get('label'))
      Cli.report(pkg)
      console.log(`acde: ${pkg.dir}. 下一步: cd ${dir} && bun install && acde dev`)
      return 0
    }
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
