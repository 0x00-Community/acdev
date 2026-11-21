#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { findRuntime, requireRuntime, run, runtimes } from 'acdev/launcher'
import { ACTIONS } from './driver/types.ts'
import { Color } from './color.ts'
import { Help } from './help.ts'
import { Exit, Output } from './output.ts'
import type { AppPackage } from './package.ts'
import { Runtime } from './runtime.ts'
import { STARTERS } from './starters.ts'
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
    uninstall: { args: [0, 1], switches: ['yes', 'data', 'keep-data'] },
    sdk: { args: [0, 2] },
    dev: { args: [0, Infinity], flags: ['out', 'app', 'desktop'], switches: ['headless', 'verbose', 'force', 'keep', 'lock'] },
    doctor: { args: [0, 1], switches: ['json', 'online', 'fix', 'yes'] },
    webs: { args: [0, 0], flags: ['session'] },
    eval: { args: [2, 2], flags: ['session'] },
    shot: { args: [1, 1], flags: ['session', 'output'] },
    inspect: { args: [0, 0], flags: ['session', 'window', 'find'], switches: ['all', 'offscreen'] },
    query: { args: [1, 1], flags: ['session', 'window', 'ref', 'limit'] },
    act: { args: [2, 3], flags: ['session'] },
    input: { args: [2, 2], flags: ['session'] },
    console: { args: [0, 0], flags: ['session', 'web', 'level', 'since'], switches: ['follow'] },
    network: { args: [0, 0], flags: ['session', 'web', 'since'], switches: ['follow', 'failed'] },
    screen: { args: [0, 0], flags: ['session', 'output'] },
    pointer: { args: [2, 2], flags: ['session'] },
    choose: { args: [1, Infinity], flags: ['session'], switches: ['cancel'] },
    drop: { args: [2, Infinity], flags: ['session', 'at'] },
    permissions: { args: [0, 0], flags: ['session'] },
    allow: { args: [0, 2], flags: ['session'], switches: ['all'] },
    deny: { args: [0, 2], flags: ['session'], switches: ['all'] },
    revoke: { args: [2, 2], flags: ['session'] },
    stop: { args: [0, 0], flags: ['session'] },
    devtools: { args: [0, 1], flags: ['session'] },
    mcp: { args: [0, 0], flags: ['session'] },
    skills: { args: [0, 1], flags: ['agent', 'dir'], switches: ['copy'] },
    vm: {
      args: [1, Infinity],
      flags: [
        'image', 'share', 'wait', 'grep', 'lines', 'bin', 'run', 'profile', 'outputs', 'output',
        'acdes', 'acdes-bin', 'system-agent-bin', 'manager-node', 'proxy-bin', 'libacde', 'dopame', 'harness', 'user',
        'audio', 'size', 'vga', 'resolution', 'btvirt', 'kernel-pkgs',
      ],
      switches: [
        'fresh', 'headless', 'vnc', 'viewer', 'sdl', 'gtk', 'gl', 'no-gl', 'detach', 'force', 'follow', 'no-restart',
        'wifi', 'bluetooth', 'battery', 'no-wifi', 'no-bluetooth', 'no-battery',
      ],
    },
    test: {
      args: [0, Infinity],
      flags: ['desktop', 'test-name-pattern', 'timeout', 'workers', 'retries', 'video'],
      switches: ['headed', 'bail', 'trace', 'update-screenshots', 'video', 'vm'],
    },
  }
  static readonly SHORT: Readonly<Record<string, string>> = {
    o: 'output', t: 'test-name-pattern', u: 'update-screenshots',
  }

  static parse(argv: readonly string[]): Args {
    const [command = '', ...rest] = argv
    const spec = Object.hasOwn(Cli.SPECS, command) ? Cli.SPECS[command]! : null
    if (!command) throw new Error('a command (acdev --help lists them)')
    if (!spec) throw new Error(`unknown command ${JSON.stringify(command)} (acdev --help lists the commands)`)
    const hint = `(acdev ${command} --help)`
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
    if (!found) throw new Error(`help: unknown command ${JSON.stringify(command)} (acdev --help lists the commands)`)
    return Help.command(found)
  }

  static async versions(): Promise<string[]> {
    const { API_LEVEL } = await import('./manifest/index.ts')
    const lines = [Versions.acde(), `sdk ${Versions.sdk()} (contract level ${API_LEVEL})`]
    const acdert = findRuntime().path
    if (!acdert) return [...lines, 'acdev runtime: not found (ACDEV_RUNTIME, next to acdev, PATH)']
    const { said, failed } = await Runtime.level(acdert)
    if (failed) return [...lines, `acdev runtime does not run (${failed}): ${acdert}`]
    const named = said.split(/\r?\n/).map((line) => line.trim())
      .find((line) => /^(?:acdev|acdert) \S+ \(contract level \d+\)$/.test(line))
    return [...lines, named ? `${named}: ${acdert}`
      : `acdev runtime without a contract level (older, level 0): ${acdert}`]
  }

  static async main(argv: readonly string[]): Promise<number> {
    const [first = ''] = argv
    if (argv.length === 0) {
      const c = Color.palette()
      console.log(`acdev ${Versions.acde()}: build, run and test apps for Dopame`)
      console.log(`  ${c.name('acdev new my-app')}   then   ${c.name('cd my-app')}   then   ${c.name('acdev dev')}`)
      console.log(`Run ${c.name('acdev --help')} for every command.`)
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
    const { Tools } = await import('./tools.ts')
    if (Tools.COMMANDS.has(command)) return await Tools.run(command, args, flags)
    if (command === 'devtools') {
      const session = Tools.pid(flags.get('session'), command)
      const say = (line: string) => console.error(line)
      const window = args[0] !== undefined ? { window: args[0] } : {}
      const { Devtools } = await import('./devtools.ts')
      return await Devtools.run({ ...window, ...(session !== undefined && { session }), say })
    }
    const followed = await Cli.follow(command, args[0] ?? '.', argv)
    if (followed !== null) return followed
    if (command === 'test') {
      const timeout = flags.has('timeout') ? Number(flags.get('timeout')) : undefined
      if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
        throw Output.option('test', 'timeout', flags.get('timeout')!, 'milliseconds per test, 1 or more')
      const workers = flags.has('workers') ? Number(flags.get('workers')) : undefined
      if (workers !== undefined && !(Number.isInteger(workers) && workers > 0))
        throw Output.option('test', 'workers', flags.get('workers')!, 'how many test files run at once, 1 or more')
      const retries = flags.has('retries') ? Number(flags.get('retries')) : undefined
      if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0))
        throw Output.option('test', 'retries', flags.get('retries')!, 'how often to run a failing test again, '
          + '0 or more')
      const video = flags.has('video') ? flags.get('video') || 'failed' : undefined
      if (video !== undefined && video !== 'on' && video !== 'failed' && video !== 'off')
        throw Output.option('test', 'video', video, 'failed (the default: only for failing tests), on or off')
      const { TestRunner } = await import('./e2e/runner.ts')
      return await TestRunner.run({
        targets: args,
        ...(flags.has('desktop') && { desktop: flags.get('desktop')! }),
        ...(flags.has('headed') && { headed: true }),
        ...(flags.has('vm') && { vm: true }),
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
    if (command === 'skills') return (await import('./skills.ts')).Skills.run(args, flags)
    if (command === 'vm') return (await import('./vm/command.ts')).runVm(args, flags)
    if (command === 'uninstall') {
      const { Uninstall } = await import('./uninstall.ts')
      const interactive = !flags.has('yes') && process.stdin.isTTY === true && process.stdout.isTTY === true
      const confirm = interactive ? Uninstall.ask : null
      if (flags.has('data') && flags.has('keep-data'))
        throw new Error('uninstall: --data or --keep-data, not both (acdev uninstall --help)')
      const data = flags.has('data') ? true : flags.has('keep-data') ? false : undefined
      const say = (line: string) => console.log(line)
      return await Uninstall.run(args[0], { yes: flags.has('yes'), confirm, say, ...(data !== undefined && { data }) })
    }
    if (command === 'doctor') return await Cli.doctor(args[0], flags)
    if (command === 'mcp') {
      const { Mcp } = await import('./mcp.ts')
      return await Mcp.serve(flags.has('session') ? { session: Tools.pid(flags.get('session')!, command) } : {})
    }
    if (command === 'new') return await Cli.create(args[0] ?? '', flags)
    if (command === 'dev') {
      const [{ DevSession }, { Sessions }] = await Promise.all([import('./dev.ts'), import('./sessions.ts')])
      const session = new DevSession({
        dirs: args,
        ...(flags.has('out') && { out: flags.get('out')! }),
        ...(flags.has('app') && { app: flags.get('app')! }),
        ...(flags.has('desktop') && { desktop: flags.get('desktop')! }),
        ...(flags.has('headless') && { headless: true }),
        ...(flags.has('verbose') && { verbose: true }),
        ...(flags.has('force') && { force: true }),
        ...(flags.has('keep') && { keep: true }),
        ...(flags.has('lock') && { lock: true }),
        ...(process.env[Sessions.TEST_ENV] === '1' && { test: true }),
        acdert: await requireRuntime(),
      })
      return await session.run()
    }
    if (command === 'sdk') {
      const { Sdk, SdkInterrupted } = await import('./sdk.ts')
      const update = args[0] === 'update'
      const dir = resolve((update ? args[1] : args[0]) ?? '.')
      if (!update && args[0] !== undefined && !existsSync(dir)) {
        throw new Error(`sdk: ${args[0]} is not a subcommand or a directory: the only subcommand is update `
          + '(acdev sdk update [dir]); acdev sdk [dir] shows the SDK of a project')
      }
      if (update) {
        try {
          console.log(await Sdk.update(dir))
        } catch (error) {
          if (!(error instanceof SdkInterrupted)) throw error
          Output.fail(error)
          return Exit.DECLINED
        }
      } else {
        const file = join(dir, 'package.json')
        if (!existsSync(file)) {
          throw new Error(`sdk: no package.json in ${dir}: run it in a project directory, or pass one `
            + '(acdev new <name> creates a project)')
        }
        for (const line of Sdk.show(dir, JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>))
          console.log(line)
      }
      return 0
    }
    const started = performance.now()
    const { AppPackage } = await import('./package.ts')
    const platform = flags.get('platform')
    if (platform !== undefined) AppPackage.platformKey(platform)
    const pkg = new AppPackage(args[0] ?? '.')
    if (command === 'check') return Cli.report(pkg, flags.get('platform') ?? AppPackage.here()) ? 0 : 1
    const built = await pkg.build(resolve(pkg.dir, flags.get('out') ?? '.acde'), { command })
    const what = [...built.desktops.map((id) => `desktop ${id}`), ...built.apps.map((id) => `app ${id}`)].join(', ')
    const into = pkg.project ? `built ${what} into ${Cli.shown(built.dir)}` : `ok: ${pkg.name} (${what})`
    const done = Color.palette().ok('acdev:')
    if (command === 'build') {
      console.log(`${done} ${into} (${Cli.took(started)})`)
      return 0
    }
    console.log(`${done} ${into}`)
    console.log(`${done} installed ${built.id} in ${pkg.install(built)} (${Cli.took(started)})`)
    return 0
  }

  static async follow(command: string, dir: string, argv: readonly string[]): Promise<number | null> {
    const bundled = import.meta.url.endsWith('.js')
    if (!['dev', 'build', 'install'].includes(command) || !bundled || process.env['ACDEV_FOLLOWED']) return null
    const current = Runtime.bun ? 'bun' : 'node'
    let wanted: 'bun' | 'node'
    try {
      const { PackageManager } = await import('./pm.ts')
      wanted = PackageManager.of(resolve(dir)).runtime
    } catch (error) {
      console.error(`acdev: ${Output.message(error)}: going on with ${current === 'bun' ? 'Bun' : 'Node.js'}`)
      return null
    }
    if (wanted === current) return null
    const exe = runtimes()[wanted]
    if (exe) {
      process.env['ACDEV_FOLLOWED'] = '1'
      return await run(argv, exe)
    }
    const needed = wanted === 'bun' ? 'Bun 1.4+' : 'Node.js 22.3+'
    const using = current === 'bun' ? 'Bun' : 'Node.js'
    console.error(`acdev: this project runs on ${needed}, which is not on PATH: going on with ${using}`)
    return null
  }

  static async doctor(dir: string | undefined, flags: ReadonlyMap<string, string>): Promise<number> {
    if (flags.has('yes') && !flags.has('fix')) throw new Error('doctor: --yes is for --fix (acdev doctor --help)')
    const options = { ...(dir !== undefined && { dir }), online: flags.has('online') }
    const json = flags.has('json')
    const [{ Doctor }, { confirm: ask }] = await Promise.all([import('./doctor.ts'), import('@clack/prompts')])
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
      confirm: interactive
        ? async (repair) => (await ask({ message: `${repair.does}?`, initialValue: false })) === true
        : null,
      allowing: 'pass --yes to allow it',
    })
    const after = fixed.some((done) => done.result === 'fixed') ? await Doctor.run(options) : checks
    if (json) console.log(Doctor.json(after, fixed))
    else if (after !== checks) console.log(`acdev doctor: after fixing:\n${Doctor.format(after)}`)
    return Doctor.failed(after) ? 1 : 0
  }

  static shown(path: string): string {
    const real = existsSync(path) ? realpathSync(path) : path
    const inside = relative(realpathSync(process.cwd()), real)
    return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path
  }

  static took(started: number): string {
    const ms = performance.now() - started
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
  }

  static async create(dir: string, flags: ReadonlyMap<string, string>): Promise<number> {
    const started = performance.now()
    const [{ Creator }, { PackageManager }, { AppPackage }, p] = await Promise.all([
      import('./create.ts'), import('./pm.ts'), import('./package.ts'), import('@clack/prompts'),
    ])
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
    if (given.template !== undefined) Creator.checkBackend(Creator.starter(given.template), given.backend)
    if (!interactive) {
      if (!given.dir) throw new Error('new: a directory (or run it in a terminal to be asked) (acdev new --help)')
      const created = await Creator.create(given, false)
      Cli.report(created.pkg, AppPackage.here())
      const made = `${created.starter.label} in ${Cli.shown(created.pkg.dir)} (${Cli.took(started)})`
      console.log(`acdev: ${made}. next: ${Creator.next(created).join(' && ')}`)
      const width = Help.terminal()
      console.log(['acdev: then:', ...Creator.LATER.flatMap((step) => Help.block(step, width, '    ', '  '))].join('\n'))
      return 0
    }
    const options = await Creator.ask(given)
    if (!options) return Exit.DECLINED
    const answered = performance.now()
    const created = await Creator.create(options, true)
    const { errors, warnings, notes } = created.pkg.check()
    for (const warning of warnings) p.log.warn(warning)
    for (const note of notes) p.log.info(note)
    for (const error of errors) p.log.error(error)
    p.note(Creator.next(created).join('\n'), 'Next')
    p.note(Creator.LATER.join('\n'), 'Then')
    const kind = created.starter.kind === 'desktop' ? 'Desktop' : `${created.starter.label} app`
    p.outro(`${kind} ${JSON.stringify(created.pkg.name)} is ready (${Cli.took(answered)})`)
    return errors.length === 0 ? 0 : 1
  }

  static report(pkg: AppPackage, platform: string | null): boolean {
    const target = platform === null ? null : pkg.platform(platform)
    const { errors, warnings, notes } = pkg.check()
    const [out, err] = [Color.palette(), Color.palette(Color.enabled(process.stderr))]
    for (const warning of warnings) console.error(`${err.warn('warning:')} ${warning}`)
    for (const note of notes) console.error(`${err.dim('note:')} ${note}`)
    for (const error of errors) console.error(`${err.error('error:')} ${error}`)
    if (errors.length === 0) console.log(`${out.ok('ok:')} ${pkg.name}, ${pkg.kind}`)
    if (!target) return errors.length === 0
    for (const note of target.notes) console.error(`${err.dim('note:')} ${note}`)
    for (const error of target.errors) console.error(`${err.error('error:')} ${error}`)
    if (target.errors.length > 0) {
      console.error(`hint: to run on ${platform} without it, list the capability in "optional" and import it `
        + `dynamically: await import('acde:<name>') rejects where the platform lacks it`)
    }
    const modes = `${platform} (${target.modes.join(', ')})`
    if (target.errors.length === 0) console.log(`${out.ok('ok:')} ${modes}: every required capability is there`)
    return errors.length === 0 && target.errors.length === 0
  }
}

Output.install()
try {
  process.exitCode = await Cli.main(process.argv.slice(2))
} catch (error) {
  Output.fail(error)
  process.exitCode = 1
}
