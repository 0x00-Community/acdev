import { rmSync } from 'node:fs'
import { LineFilter, logCommand } from './logs.ts'
import { DevLoop } from './loop.ts'
import { audioOf, resolutionOf, vgaOf } from './hardware.ts'
import { Usb } from './usb.ts'
import { Machine, type StartOptions, type Stopped } from './machine.ts'
import { PROVISION_DIR, provisionOptions, provisionSources, stageProvision } from './provision.ts'
import { guestHardware } from './guesthw.ts'

type Flags = ReadonlyMap<string, string>
type Handler = (machine: Machine, rest: readonly string[], flags: Flags) => Promise<number>

const WAIT = 300

function say(line: string): void {
  console.error(`acdev vm: ${line}`)
}

function seconds(text: string | undefined): number {
  if (text === undefined) return WAIT
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0) throw new Error(`vm: --wait ${text}: seconds, 0 or more`)
  return value
}

function whole(flag: string, text: string | undefined, min: number, max: number, fallback: number): number {
  if (text === undefined) return fallback
  const value = Number(text)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`vm: --${flag} ${text}: a whole number from ${min} to ${max}`)
  return value
}

function outputsFor(flags: Flags, display: StartOptions['display']): number {
  const outputs = whole('outputs', flags.get('outputs'), 1, Machine.MAX_OUTPUTS, 1)
  if (outputs > 1 && (display === 'viewer' || display === 'vnc')) {
    throw new Error(`vm start: --outputs ${outputs} needs QEMU's window or --headless; --${display} shows only the first output`)
  }
  return outputs
}

const DISPLAYS: readonly [string, NonNullable<StartOptions['display']>][] = [
  ['headless', 'none'], ['vnc', 'vnc'], ['viewer', 'viewer'], ['sdl', 'sdl'], ['gtk', 'gtk'],
]

export function displayOf(flags: Flags): NonNullable<StartOptions['display']> {
  const shown = DISPLAYS.filter(([flag]) => flags.has(flag))
  if (shown.length > 1) {
    throw new Error(`vm start: one of --headless, --vnc, --viewer, --sdl, --gtk, not ${shown.map(([flag]) => `--${flag}`).join(' and ')}`)
  }
  return shown[0]?.[1] ?? 'window'
}

function count(sub: string, rest: readonly string[], min: number, max: number, usage: string): void {
  if (rest.length < min || rest.length > max) throw new Error(`vm ${sub}: ${usage} (acdev vm --help)`)
}

async function start(machine: Machine, rest: readonly string[], flags: Flags): Promise<number> {
  count('start', rest, 0, 0, 'options only')
  const display = displayOf(flags)
  const options: StartOptions = {
    ...(flags.has('image') && { image: flags.get('image')! }),
    ...(flags.has('share') && { share: Machine.directory(flags.get('share')!) }),
    ...(flags.has('fresh') && { fresh: true }),
    ...(flags.has('no-gl') ? { gl: false } : flags.has('gl') ? { gl: true } : {}),
    display,
    outputs: outputsFor(flags, display),
    audio: audioOf(flags.get('audio')),
    vga: vgaOf(flags.get('vga')),
    resolution: resolutionOf(flags.get('resolution')),
  }
  const wait = seconds(flags.get('wait'))
  if (wait !== 0) machine.devdBinary()
  const pid = await machine.start(options, say)
  say(`qemu is running (pid ${pid}); serial log ${machine.serial}`)
  try {
    return await afterStart(machine, options, wait)
  } catch (error) {
    machine.abandon(pid)
    say(`stopped qemu (pid ${pid}): the start did not finish`)
    throw error
  }
}

async function afterStart(machine: Machine, options: StartOptions, wait: number): Promise<number> {
  const outputs = options.outputs ?? 1
  if (options.display === 'none' && outputs > 1) {
    await machine.switchOnOutputs()
    say(`displays 1 to ${outputs - 1} are switched on (QEMU's D-Bus display, no window)`)
  }
  if (options.display === 'viewer') say(`acdevtool view shows the guest (pid ${machine.view()}; log ${machine.logs}/viewer.log)`)
  if (wait === 0) return 0
  if (await machine.ready(wait)) {
    await machine.checkCpu()
    say(`the guest is ready; acdevd ${await machine.installDevd(say)} answers over ${machine.describeLink()}`)
    return 0
  }
  say(`the guest agent did not answer in ${wait} s; the guest still runs (acdev vm wait, acdev vm stop)`)
  return 1
}

async function status(machine: Machine, rest: readonly string[]): Promise<number> {
  count('status', rest, 0, 0, 'no arguments')
  const pid = machine.pid()
  console.log(`dir: ${machine.dir}`)
  const base = machine.overlayBase()
  const fetched = machine.image()
  const image = base ? `${base} (under the overlay disk)` : fetched ? `${fetched} (the newest fetched)` : 'none (acdev vm fetch, or start --image)'
  console.log(`image: ${image}`)
  console.log(`accelerator: ${machine.accelerator()}`)
  if (pid === null) {
    console.log('guest: not running')
    return 0
  }
  console.log(`guest: running (pid ${pid}), ${(await machine.ready(0)) ? 'ready' : 'not ready yet'}`)
  const devd = await machine.devd().version().catch((error: Error) => `not answering (${error.message})`)
  console.log(`acdevd (over ${machine.describeLink()}): ${devd}`)
  console.log(`serial log: ${machine.serial}`)
  return 0
}

async function shell(machine: Machine, rest: readonly string[]): Promise<number> {
  machine.running()
  const { stdin, stdout } = process
  const area = () => ({ rows: stdout.rows || 24, cols: stdout.columns || 80 })
  const argv = rest.length ? ['/bin/sh', '-c', rest.join(' ')] : []
  const session = machine.devd().shell({ argv, term: process.env['TERM'] || 'xterm-256color', ...area() }, (chunk) => stdout.write(chunk))
  const input = (data: Buffer) => session.input(data)
  const ended = () => session.input(Buffer.from([4]))
  const resized = () => session.resize(area().rows, area().cols)
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.on('data', input).on('end', ended)
  stdout.on('resize', resized)
  try {
    return await session.exit
  } finally {
    stdin.off('data', input).off('end', ended)
    stdout.off('resize', resized)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
}

async function logs(machine: Machine, rest: readonly string[], flags: Flags): Promise<number> {
  count('logs', rest, 0, 1, 'at most one SOURCE: a process group id, a guest file or a systemd unit')
  machine.running()
  const lines = Number(flags.get('lines') ?? 50)
  if (!Number.isInteger(lines) || lines < 0) throw new Error(`vm logs: --lines ${flags.get('lines')}: a count, 0 or more`)
  const filter = new LineFilter(flags.get('grep'), (text) => process.stdout.write(text))
  const command = logCommand(rest[0], { follow: flags.has('follow'), lines })
  const code = await machine.devd().run(['/bin/sh', '-c', command], {
    stdout: (chunk) => filter.push(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  })
  filter.end()
  return code
}

async function dev(machine: Machine, rest: readonly string[], flags: Flags): Promise<number> {
  count('dev', rest, 0, 1, 'at most the Cargo project DIR')
  machine.running()
  const bins = (flags.get('bin') ?? '').split(',').map((bin) => bin.trim()).filter(Boolean)
  const options = { dir: rest[0] ?? '.', bins, run: flags.get('run') ?? null, ...(flags.has('profile') && { profile: flags.get('profile')! }) }
  const loop = new DevLoop(machine.devd(), options, say)
  const stopped = new AbortController()
  const stop = () => stopped.abort()
  process.on('SIGINT', stop).on('SIGTERM', stop)
  say(`watching ${loop.dir}; Ctrl+C stops the program and ends`)
  try {
    await loop.watch(stopped.signal)
  } finally {
    process.off('SIGINT', stop).off('SIGTERM', stop)
  }
  return 0
}

const STOPPED: Readonly<Record<Stopped, string>> = {
  'not running': 'not running',
  devd: 'powered off: acdevd ran systemctl poweroff',
  agent: 'powered off by the guest agent (acdevd did not answer or could not run systemctl poweroff)',
  acpi: 'powered off by the ACPI power button (neither acdevd nor the guest agent did it)',
  killed: 'the guest did not power off: killed qemu (SIGTERM)',
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  async fetch(machine, rest) {
    count('fetch', rest, 0, 0, 'no arguments')
    console.log(await machine.fetch(say))
    return 0
  },
  start,
  async stop(machine, rest) {
    count('stop', rest, 0, 0, 'no arguments')
    say(STOPPED[await machine.stop(say)])
    return 0
  },
  status,
  async wait(machine, rest) {
    count('wait', rest, 0, 1, 'at most SECONDS')
    const ready = await machine.ready(seconds(rest[0]))
    if (!ready) say('the guest agent does not answer')
    return ready ? 0 : 1
  },
  async screenshot(machine, rest, flags) {
    count('screenshot', rest, 1, 1, 'FILE.png')
    console.log(await machine.screenshot(rest[0]!, whole('output', flags.get('output'), 0, Machine.MAX_OUTPUTS - 1, 0)))
    return 0
  },
  async run(machine, rest, flags) {
    count('run', rest, 1, Infinity, 'a command')
    machine.running()
    const argv = ['/bin/sh', '-c', rest.join(' ')]
    if (flags.has('detach')) {
      const { pid, log } = await machine.devd().detach(argv)
      console.log(pid)
      say(`running in the background as process group ${pid}; its output goes to guest:${log} (acdev vm logs ${pid} --follow, acdev vm kill ${pid})`)
      return 0
    }
    return machine.devd().run(argv, {
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
    })
  },
  shell,
  logs,
  dev,
  async kill(machine, rest, flags) {
    count('kill', rest, 1, 1, 'PID')
    machine.running()
    const pid = Number(rest[0])
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`vm kill: ${rest[0]} is not a process id`)
    await machine.devd().kill(pid, flags.has('force'))
    say(`stopped process group ${pid}`)
    return 0
  },
  async push(machine, rest) {
    count('push', rest, 1, 2, 'LOCAL [REMOTE]')
    say(`${rest[0]} -> guest:${await machine.push(rest[0]!, rest[1])}`)
    return 0
  },
  async provision(machine, rest, flags) {
    count('provision', rest, 0, 0, 'no arguments')
    machine.running()
    const options = provisionOptions(flags)
    const stage = stageProvision(provisionSources(flags), guestHardware(flags))
    try {
      const devd = machine.devd()
      await devd.run(['/bin/rm', '-rf', PROVISION_DIR])
      await machine.push(stage, PROVISION_DIR)
      const argv = ['/bin/bash', `${PROVISION_DIR}/provision.sh`, options.user, options.password, options.restart ? '1' : '0']
      return await devd.run(argv, { stdout: (chunk) => process.stdout.write(chunk), stderr: (chunk) => process.stderr.write(chunk) })
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  },
  async pull(machine, rest) {
    count('pull', rest, 1, 2, 'REMOTE [LOCAL]')
    const { target, files } = await machine.pull(rest[0]!, rest[1])
    say(`guest:${rest[0]} -> ${target} (${files} file${files === 1 ? '' : 's'})`)
    return 0
  },
  async view(machine, rest) {
    count('view', rest, 0, 0, 'no arguments')
    say(`acdevtool view shows the guest (pid ${machine.view()}; log ${machine.logs}/viewer.log)`)
    return 0
  },
  async mount(machine, rest) {
    count('mount', rest, 0, 0, 'no arguments')
    say(`guest:${Machine.SHARE} is ${await machine.mount()}`)
    return 0
  },
  async usb(machine, rest, flags) {
    const [action, ...more] = rest
    if (action === 'add') {
      count('usb add', more, 1, 1, 'IMAGE [--size SIZE]')
      const stick = await machine.usb().add(more[0]!, Usb.size(flags.get('size')))
      say(`${stick.image} is plugged in as ${stick.id} (a USB stick on the guest's xHCI controller)`)
      return 0
    }
    if (action === 'remove') {
      count('usb remove', more, 0, 1, '[IMAGE or ID]')
      const stick = await machine.usb().remove(more[0])
      say(`${stick.id} (${stick.image}) is unplugged`)
      return 0
    }
    if (action === 'list' || action === undefined) {
      for (const stick of machine.usb().list()) console.log(`${stick.id}\t${stick.image}`)
      return 0
    }
    throw new Error(`vm usb: ${action}: add, remove or list (acdev vm --help)`)
  },
  async wake(machine, rest) {
    count('wake', rest, 0, 0, 'no arguments')
    await machine.wake()
    say('sent the wake-up (QMP system_wakeup); a guest that is not asleep ignores it')
    return 0
  },
  async console(machine, rest) {
    count('console', rest, 0, 0, 'no arguments')
    for (const entry of await machine.console()) console.log(entry)
    say('from the next boot the guest kernel logs to the serial port too')
    return 0
  },
}

export function runVm(args: readonly string[], flags: Flags): Promise<number> {
  const [sub = '', ...rest] = args
  const handler = Object.hasOwn(HANDLERS, sub) ? HANDLERS[sub]! : null
  if (!handler) {
    throw new Error(`vm: ${sub ? `unknown subcommand ${JSON.stringify(sub)}` : 'a subcommand'}: `
      + `${Object.keys(HANDLERS).join(', ')} (acdev vm --help)`)
  }
  return handler(new Machine(), rest, flags)
}
