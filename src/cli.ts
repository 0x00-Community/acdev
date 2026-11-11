#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as p from '@clack/prompts'
import { API_LEVEL } from '@dopame/acde-api/manifest'
import { findAcdert, requireAcdert, run, runtimes } from 'acde/launcher'
import { Creator, STARTERS } from './create.ts'
import { DevSession } from './dev.ts'
import { Doctor } from './doctor.ts'
import { ACTIONS } from './driver/acde.ts'
import { TestRunner } from './e2e/runner.ts'
import { Help } from './help.ts'
import { Mcp } from './mcp.ts'
import { PackageManager } from './pm.ts'
import { AppPackage } from './package.ts'
import { Runtime } from './runtime.ts'
import { Sdk } from './sdk.ts'
import { Skills } from './skills.ts'
import { Tools } from './tools.ts'
import { Versions } from './versions.ts'


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
    new: {
      args: [0, 1],
      flags: ['id', 'label', 'template', 'pm'],
      switches: ['backend', 'install', 'no-install', 'git', 'yes'],
    },
    check: { args: [0, 1], flags: ['platform'] },
    build: { args: [0, 1], flags: ['out'] },
    install: { args: [0, 1], flags: ['out'] },
    sdk: { args: [0, 2] },
    dev: { args: [0, Infinity], flags: ['out', 'app', 'desktop'], switches: ['headless'] },
    doctor: { args: [0, 1], switches: ['json', 'online', 'fix', 'yes'] },
    webs: { args: [0, 0], flags: ['session'] },
    eval: { args: [2, 2], flags: ['session'] },
    shot: { args: [1, 1], flags: ['session', 'output'] },
    inspect: { args: [0, 0], flags: ['session', 'window', 'find'], switches: ['all', 'offscreen'] },
    query: { args: [1, 1], flags: ['session', 'window', 'ref', 'limit'] },
    act: { args: [2, 3], flags: ['session'] },
    console: { args: [0, 0], flags: ['session', 'web', 'level', 'since'], switches: ['follow'] },
    network: { args: [0, 0], flags: ['session', 'web', 'since'], switches: ['follow', 'failed'] },
    screen: { args: [0, 0], flags: ['session', 'output'] },
    pointer: { args: [2, 2], flags: ['session'] },
    permissions: { args: [0, 0], flags: ['session'] },
    allow: { args: [0, 2], flags: ['session'], switches: ['all'] },
    deny: { args: [0, 2], flags: ['session'], switches: ['all'] },
    revoke: { args: [2, 2], flags: ['session'] },
    stop: { args: [0, 0], flags: ['session'] },
    mcp: { args: [0, 0], flags: ['session'] },
    skills: { args: [0, 1], flags: ['agent', 'dir'], switches: ['copy'] },
    test: {
      args: [0, Infinity],
      flags: ['desktop', 'test-name-pattern', 'timeout', 'workers', 'retries', 'video'],
      switches: ['headed', 'bail', 'trace', 'update-screenshots', 'video'],
    },
  }
  static readonly SHORT: Readonly<Record<string, string>> = {
    o: 'output', t: 'test-name-pattern', u: 'update-screenshots',
  }

  static parse(argv: readonly string[]): Args {
    const [command = '', ...rest] = argv
    const spec = Object.hasOwn(Cli.SPECS, command) ? Cli.SPECS[command]! : null
    if (!command) throw new Error('a command (acde --help lists them)')
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

  static readonly HELP = Help.commands(STARTERS.map((s) => s.name), ACTIONS)

  static usage(command: string): string {
    if (!command) return Help.overview(Cli.HELP, Versions.acde())
    const found = Cli.HELP.find((item) => item.name === command)
    if (!found) throw new Error(`help: unknown command ${JSON.stringify(command)} (acde --help lists the commands)`)
    return Help.command(found)
  }

  static async versions(): Promise<string[]> {
    const lines = [Versions.acde(), `sdk ${Versions.sdk()} (contract level ${API_LEVEL})`]
    const acdert = findAcdert().path
    if (!acdert) return [...lines, 'acdert: not found (ACDERT, next to acde, PATH)']
    const { said, failed } = await DevSession.runtimeLevel(acdert)
    if (failed) return [...lines, `acdert does not run (${failed}): ${acdert}`]
    const named = said.split(/\r?\n/).map((line) => line.trim())
      .find((line) => /^acdert \S+ \(contract level \d+\)$/.test(line))
    return [...lines, named ? `${named}: ${acdert}` : `acdert without a contract level (older, level 0): ${acdert}`]
  }

  static async main(argv: readonly string[]): Promise<number> {
    const [first = ''] = argv
    if (argv.length === 0) {
      console.log(`acde ${Versions.acde()}: acde --help lists the commands`)
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
      const workers = flags.has('workers') ? Number(flags.get('workers')) : undefined
      if (workers !== undefined && !(Number.isInteger(workers) && workers > 0))
        throw new Error(`--workers ${flags.get('workers')}: how many test files run at once (1 or more)`)
      const retries = flags.has('retries') ? Number(flags.get('retries')) : undefined
      if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0))
        throw new Error(`--retries ${flags.get('retries')}: how many times to run a failing test again (0 or more)`)
      const video = flags.has('video') ? flags.get('video') || 'failed' : undefined
      if (video !== undefined && video !== 'on' && video !== 'failed' && video !== 'off')
        throw new Error(`--video=${video}: failed (the default: only for failing tests), on or off`)
      return await TestRunner.run({
        targets: args,
        ...(flags.has('desktop') && { desktop: flags.get('desktop')! }),
        ...(flags.has('headed') && { headed: true }),
        ...(flags.has('bail') && { bail: true }),
        ...(flags.has('trace') && { trace: true }),
        ...(flags.has('update-screenshots') && { update: true }),
        ...(flags.has('test-name-pattern') && { pattern: flags.get('test-name-pattern')! }),
        ...(timeout !== undefined && { timeout }),
        ...(workers !== undefined && { workers }),
        ...(retries !== undefined && { retries }),
        ...(video !== undefined && { video }),
      })
    }
    if (command === 'skills') return Skills.run(args, flags)
    if (command === 'doctor') return await Cli.doctor(args[0], flags)
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
    if (command === 'sdk') {
      const update = args[0] === 'update'
      const dir = resolve((update ? args[1] : args[0]) ?? '.')
      if (update) console.log(await Sdk.update(dir))
      else {
        const file = join(dir, 'package.json')
        if (!existsSync(file)) throw new Error(`sdk: no package.json in ${dir}`)
        for (const line of Sdk.show(dir, JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>))
          console.log(line)
      }
      return 0
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

  static async doctor(dir: string | undefined, flags: ReadonlyMap<string, string>): Promise<number> {
    if (flags.has('yes') && !flags.has('fix')) throw new Error('doctor: --yes is for --fix (acde doctor --help)')
    const options = { ...(dir !== undefined && { dir }), online: flags.has('online') }
    const json = flags.has('json')
    const checks = await Doctor.run(options)
    if (!flags.has('fix')) {
      console.log(json ? Doctor.json(checks) : Doctor.format(checks))
      return Doctor.failed(checks) ? 1 : 0
    }
    if (!json) console.log(Doctor.format(checks))
    const interactive = !json && !flags.has('yes') && process.stdin.isTTY === true && process.stdout.isTTY === true
    const fixed = await Doctor.fix(checks, {
      yes: flags.has('yes'),
      output: json ? 'stderr' : 'inherit',
      say: (line) => (json ? console.error(line) : console.log(line)),
      confirm: interactive ? async (repair) => (await p.confirm({ message: `${repair.does}?`, initialValue: false })) === true : null,
      allowing: 'pass --yes to allow it',
    })
    const after = fixed.some((done) => done.result === 'fixed') ? await Doctor.run(options) : checks
    if (json) console.log(Doctor.json(after, fixed))
    else if (after !== checks) console.log(`acde doctor: after fixing:\n${Doctor.format(after)}`)
    return Doctor.failed(after) ? 1 : 0
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
      ...(flags.has('no-install') && { install: false }),
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
    const { errors, warnings, notes } = created.pkg.check()
    for (const warning of warnings) p.log.warn(warning)
    for (const note of notes) p.log.info(note)
    for (const error of errors) p.log.error(error)
    p.note(Creator.next(created).join('\n'), 'Next')
    p.note(Creator.LATER.join('\n'), 'Then')
    const kind = created.starter.kind === 'desktop' ? 'Desktop' : `${created.starter.label} app`
    p.outro(`${kind} ${JSON.stringify(created.pkg.name)} is ready`)
    return errors.length === 0 ? 0 : 1
  }

  static report(pkg: AppPackage, platform = AppPackage.here()): boolean {
    const target = platform === null ? null : pkg.platform(platform)
    const { errors, warnings, notes } = pkg.check()
    for (const warning of warnings) console.error(`warning: ${warning}`)
    for (const note of notes) console.error(`note: ${note}`)
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
