import { Machine, type StartOptions } from './machine.ts'

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

function count(sub: string, rest: readonly string[], min: number, max: number, usage: string): void {
  if (rest.length < min || rest.length > max) throw new Error(`vm ${sub}: ${usage} (acdev vm --help)`)
}

async function start(machine: Machine, rest: readonly string[], flags: Flags): Promise<number> {
  count('start', rest, 0, 0, 'options only')
  if (flags.has('headless') && flags.has('vnc')) throw new Error('vm start: --headless or --vnc, not both')
  const options: StartOptions = {
    ...(flags.has('image') && { image: flags.get('image')! }),
    ...(flags.has('share') && { share: Machine.directory(flags.get('share')!) }),
    ...(flags.has('fresh') && { fresh: true }),
    ...(flags.has('gl') && { gl: true }),
    display: flags.has('headless') ? 'none' : flags.has('vnc') ? 'vnc' : 'window',
  }
  const wait = seconds(flags.get('wait'))
  const pid = await machine.start(options, say)
  say(`qemu is running (pid ${pid}); serial log ${machine.serial}`)
  if (wait === 0) return 0
  if (await machine.ready(wait)) {
    say('the guest is ready')
    return 0
  }
  say(`the guest agent did not answer in ${wait} s; the guest still runs (acdev vm wait, acdev vm stop)`)
  return 1
}

async function status(machine: Machine, rest: readonly string[]): Promise<number> {
  count('status', rest, 0, 0, 'no arguments')
  const pid = machine.pid()
  console.log(`dir: ${machine.dir}`)
  console.log(`image: ${machine.image() ?? 'none (acdev vm fetch)'}`)
  console.log(`kvm: ${Machine.kvm() ? 'yes' : 'no (/dev/kvm does not open: TCG)'}`)
  if (pid === null) {
    console.log('guest: not running')
    return 0
  }
  console.log(`guest: running (pid ${pid}), ${(await machine.ready(0)) ? 'ready' : 'not ready yet'}`)
  console.log(`serial log: ${machine.serial}`)
  return 0
}

const STOPPED = { 'not running': 'not running', off: 'powered off', killed: 'no power-off in 60 s: killed qemu' }

const HANDLERS: Readonly<Record<string, Handler>> = {
  async fetch(machine, rest) {
    count('fetch', rest, 0, 0, 'no arguments')
    console.log(await machine.fetch(say))
    return 0
  },
  start,
  async stop(machine, rest) {
    count('stop', rest, 0, 0, 'no arguments')
    say(STOPPED[await machine.stop()])
    return 0
  },
  status,
  async wait(machine, rest) {
    count('wait', rest, 0, 1, 'at most SECONDS')
    const ready = await machine.ready(seconds(rest[0]))
    if (!ready) say('the guest agent does not answer')
    return ready ? 0 : 1
  },
  async screenshot(machine, rest) {
    count('screenshot', rest, 1, 1, 'FILE.png')
    console.log(await machine.screenshot(rest[0]!))
    return 0
  },
  async run(machine, rest) {
    count('run', rest, 1, Infinity, 'a command')
    const done = await machine.exec(rest.join(' '))
    process.stdout.write(done.stdout)
    process.stderr.write(done.stderr)
    return done.code
  },
  async push(machine, rest) {
    count('push', rest, 1, 2, 'LOCAL [REMOTE]')
    say(`${rest[0]} -> guest:${await machine.push(rest[0]!, rest[1])}`)
    return 0
  },
  async mount(machine, rest) {
    count('mount', rest, 0, 0, 'no arguments')
    say(`guest:${Machine.SHARE} is ${await machine.mount()}`)
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
