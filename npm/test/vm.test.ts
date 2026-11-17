import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { which } from '../launcher.mjs'
import { GuestAgent, monitor } from '../src/vm/channel.ts'
import { Devd, encode, Frames, Kind, type Frame, type Transport } from '../src/vm/devd.ts'
import { Machine } from '../src/vm/machine.ts'
import { DEVD_LOGS, LineFilter, logCommand } from '../src/vm/logs.ts'
import { cleanup, collect, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

afterAll(cleanup)

function serve(path: string, answer: (socket: Socket, message: Record<string, unknown>) => void, hello = ''): Server {
  const server = createServer((socket) => {
    if (hello) socket.write(hello)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim()) answer(socket, JSON.parse(line) as Record<string, unknown>)
      }
    })
  })
  server.listen(path)
  return server
}

const reply = (socket: Socket, value: unknown) => socket.write(`${JSON.stringify({ return: value })}\n`)

describe('the guest agent and QMP over their sockets', () => {
  test('guest-sync skips what an earlier client left; exec gives the exit code and output; write sends chunks', async () => {
    const dir = tmp()
    const written: Buffer[] = []
    const server = serve(join(dir, 'qga.sock'), (socket, message) => {
      const args = (message['arguments'] ?? {}) as Record<string, unknown>
      switch (message['execute']) {
        case 'guest-sync': return reply(socket, args['id'])
        case 'guest-exec': return reply(socket, { pid: 7 })
        case 'guest-exec-status':
          return reply(socket, { exited: true, exitcode: 3, 'out-data': Buffer.from('out\n').toString('base64') })
        case 'guest-file-open': return reply(socket, 9)
        case 'guest-file-write':
          written.push(Buffer.from(args['buf-b64'] as string, 'base64'))
          return reply(socket, { count: 1 })
        default: return reply(socket, {})
      }
    }, '{"return": 12345}\nnot json\n')
    try {
      const agent = await GuestAgent.open(join(dir, 'qga.sock'))
      const done = await agent.exec('exit 3', 5_000)
      expect(done.code).toBe(3)
      expect(done.stdout.toString()).toBe('out\n')
      const data = Buffer.alloc(GuestAgent.CHUNK * 2 + 5, 7)
      await agent.write('/opt/x', data)
      expect(written.length).toBe(3)
      expect(Buffer.concat(written).equals(data)).toBe(true)
      agent.close()
      expect(await GuestAgent.ping(join(dir, 'qga.sock'), 0)).toBe(true)
      expect(await GuestAgent.ping(join(dir, 'nothing.sock'), 0)).toBe(false)
    } finally {
      server.close()
    }
  })

  test('QMP: the greeting, capabilities, events skipped, the answer', async () => {
    const dir = tmp()
    const server = serve(join(dir, 'qmp.sock'), (socket, message) => {
      socket.write('{"event": "SOMETHING"}\n')
      reply(socket, message['execute'] === 'qmp_capabilities' ? {} : { got: message['execute'], args: message['arguments'] })
    }, '{"QMP": {"version": {}}}\n')
    try {
      expect(await monitor(join(dir, 'qmp.sock'), 'screendump', { filename: '/x.png' }))
        .toEqual({ got: 'screendump', args: { filename: '/x.png' } })
    } finally {
      server.close()
    }
  })
})

class Scripted implements Transport {
  readonly sent: Frame[] = []
  constructor(readonly answer: (sent: Frame[]) => Frame[]) {}

  open() {
    const decoder = new Frames()
    const sent = this.sent
    const answer = this.answer
    let replies: Frame[] = []
    return {
      write: (data: Buffer) => {
        sent.push(...decoder.push(data))
        replies = answer(sent)
      },
      end: () => undefined,
      frames: (async function* () {
        await Promise.resolve()
        yield* replies
      })(),
      close: () => undefined,
    }
  }
}

const frame = (kind: string, body: Buffer = Buffer.alloc(0)): Frame => ({ kind, body })
const u32 = (value: number) => {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value, 0)
  return out
}

describe('the acdevd protocol, host side', () => {
  test('frames split and join across chunks', () => {
    const decoder = new Frames()
    const bytes = Buffer.concat([encode(Kind.VERSION), encode(Kind.DATA, Buffer.from('hello'))])
    expect(decoder.push(bytes.subarray(0, 7))).toEqual([frame(Kind.VERSION)])
    expect(decoder.push(bytes.subarray(7)).map((f) => [f.kind, f.body.toString()])).toEqual([[Kind.DATA, 'hello']])
  })

  test('run sends the argv, streams the output and returns the exit code', async () => {
    const exit = Buffer.alloc(4)
    exit.writeInt32LE(3, 0)
    const transport = new Scripted(() => [frame(Kind.PID, u32(42)), frame(Kind.STDOUT, Buffer.from('out')),
      frame(Kind.STDERR, Buffer.from('err')), frame(Kind.EXIT, exit)])
    const seen: string[] = []
    const code = await new Devd(transport).run(['/bin/sh', '-c', 'x'], {
      pid: (pid) => seen.push(`pid ${pid}`), stdout: (b) => seen.push(`out ${b}`), stderr: (b) => seen.push(`err ${b}`),
    })
    expect(code).toBe(3)
    expect(seen).toEqual(['pid 42', 'out out', 'err err'])
    expect(transport.sent[0]!.body.toString()).toBe('\0/bin/sh\0-c\0x\0')
  })

  test('shell sends the size, TERM and argv, then input and resizes; returns the exit code', async () => {
    const exit = Buffer.alloc(4)
    exit.writeInt32LE(4, 0)
    const transport = new Scripted((sent) => (sent.length < 4 ? [] : [frame(Kind.PID, u32(9)), frame(Kind.STDOUT, Buffer.from('$ ')), frame(Kind.EXIT, exit)]))
    const seen: string[] = []
    const session = new Devd(transport).shell({ argv: ['/bin/sh'], rows: 30, cols: 100, term: 'xterm' }, (b) => seen.push(b.toString()))
    session.input(Buffer.from('ls\r'))
    session.resize(40, 120)
    session.input(Buffer.from([4]))
    expect(await session.exit).toBe(4)
    expect(seen).toEqual(['$ '])
    const [open, typed, resized] = transport.sent
    expect([open!.kind, open!.body.readUInt16LE(0), open!.body.readUInt16LE(2), open!.body.subarray(4).toString()])
      .toEqual([Kind.SHELL, 30, 100, 'xterm\0/bin/sh\0'])
    expect([typed!.kind, typed!.body.toString()]).toEqual([Kind.DATA, 'ls\r'])
    expect([resized!.kind, resized!.body.readUInt16LE(0), resized!.body.readUInt16LE(2)]).toEqual([Kind.RESIZE, 40, 120])
  })

  test('push sends each file with its mode, then Z; an error comes back as an Error', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.txt'), 'A')
    const ok = new Scripted((sent) => (sent.at(-1)?.kind === Kind.DONE ? [frame(Kind.OK, u32(1))] : []))
    expect(await new Devd(ok).push(Devd.files(join(dir, 'a.txt'), '/opt/a.txt'))).toBe(1)
    expect(ok.sent.map((f) => f.kind)).toEqual([Kind.PUSH, Kind.DATA, Kind.END, Kind.DONE])
    expect(ok.sent[0]!.body.readUInt32LE(0)).toBe(0o644)
    expect(ok.sent[0]!.body.subarray(4).toString()).toBe('/opt/a.txt')
    const refused = new Scripted(() => [frame(Kind.ERROR, Buffer.from('no room'))])
    await expect(new Devd(refused).kill(7)).rejects.toThrow('acdevd: no room')
  })
})

describe('acdev vm logs', () => {
  test('a process group id or a path is a file, a name a unit, nothing the whole journal', () => {
    expect(logCommand('42', { follow: true, lines: 10 })).toBe(`exec tail -n 10 -F '${DEVD_LOGS}/42.log'`)
    expect(logCommand("/var/log/it's.log", { follow: false, lines: 5 })).toBe("exec tail -n 5 '/var/log/it'\\''s.log'")
    expect(logCommand('greetd', { follow: true, lines: 50 })).toBe("exec journalctl --no-pager -o short-precise -n 50 -f -u 'greetd'")
    expect(logCommand(undefined, { follow: false, lines: 0 })).toBe('exec journalctl --no-pager -o short-precise -n 0')
  })

  test('the filter keeps whole matching lines across chunks, ignoring case', () => {
    const seen: string[] = []
    const filter = new LineFilter('frame', (text) => seen.push(text))
    filter.push(Buffer.from('winman: Frame 1\nother\nwinman: fra'))
    filter.push(Buffer.from('me 2\nlast frame'))
    filter.end()
    expect(seen).toEqual(['winman: Frame 1\n', 'winman: frame 2\n', 'last frame\n'])
    const all: string[] = []
    new LineFilter(undefined, (text) => all.push(text)).push(Buffer.from('as is'))
    expect(all).toEqual(['as is'])
  })
})

describe('the QEMU command line', () => {
  test('KVM, virtio display, keyboard and tablet, the serial log, the share', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({ display: 'none', share: '/srv/out' }, true).join(' ')
    for (const part of ['-accel kvm', '-device virtio-vga', '-device virtio-keyboard-pci', '-device virtio-tablet-pci',
      '-display none', `path=${machine.serial}`, `vhost-vsock-pci,guest-cid=${machine.cid()}`, 'local,path=/srv/out,mount_tag=acdev', 'file=/c.fd']) {
      expect(args).toContain(part)
    }
    expect(machine.args({}, false).join(' ')).toContain('-accel tcg,thread=multi -cpu max -smp')
    expect(machine.args({ gl: true }, true).join(' ')).toContain('-device virtio-vga-gl -display gtk,gl=on')
  })

  test('acdev vm: an unknown subcommand, and stop or status with no guest', async () => {
    const dir = tmp()
    const run = (args: string[]) => collect([process.execPath, CLI, 'vm', ...args], { cwd: dir, env: env({ ACDEV_VM_DIR: dir }) })
    const unknown = await run(['bogus'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown subcommand "bogus": fetch, start, stop')
    expect((await run(['stop'])).stderr).toBe('acdev vm: not running\n')
    expect((await run(['status'])).stdout).toContain('guest: not running')
    expect((await run(['run', 'true'])).stderr).toContain(`no guest is running from ${dir}`)
  })
})

const IMAGE = process.env['ACDEV_VM_TEST_IMAGE'] ?? ''
const QEMU = which('qemu-system-x86_64') !== null && Machine.kvm() && IMAGE !== '' && existsSync(IMAGE)

describe('a real guest (ACDEV_VM_TEST_IMAGE, QEMU and KVM)', () => {
  test.skipIf(!QEMU)('start --headless waits until ready with acdevd; run, push, detach, logs and kill, shell, screenshot; stop', async () => {
    const dir = tmp()
    const run = (args: string[]) => collect([process.execPath, CLI, 'vm', ...args], { cwd: dir, env: env({ ACDEV_VM_DIR: dir }) })
    try {
      const started = await run(['start', '--headless', '--image', IMAGE])
      expect(started.code, started.out).toBe(0)
      expect(started.stderr).toContain('answers over vsock')
      const ran = await run(['run', '--', 'echo hello; exit 3'])
      expect(ran.code).toBe(3)
      expect(ran.stdout).toBe('hello\n')
      expect((await run(['push', CLI, '/opt/acdev/cli.ts'])).code).toBe(0)
      expect((await run(['run', 'cmp -s /opt/acdev/cli.ts /dev/null; wc -c < /opt/acdev/cli.ts'])).stdout.trim())
        .toBe(String(readFileSync(CLI).length))
      const detached = await run(['run', '--detach', '--', 'echo up; exec sleep 60'])
      expect(detached.code, detached.out).toBe(0)
      const pid = detached.stdout.trim()
      const logged = await run(['logs', pid, '--grep', 'UP'])
      expect(logged.code, logged.out).toBe(0)
      expect(logged.stdout).toBe('up\n')
      expect((await run(['kill', pid])).code).toBe(0)
      expect((await run(['run', `cat /var/log/acdevd/${pid}.log`])).stdout).toBe('up\n')
      expect((await run(['logs', 'acdevd', '--lines', '20'])).stdout).toContain('listening on vsock port')
      const shell = await run(['shell', '--', 'stty size; [ -t 0 ] && echo tty; exit 4'])
      expect(shell.code, shell.out).toBe(4)
      expect(shell.stdout).toContain('24 80')
      expect(shell.stdout).toContain('tty')
      expect((await run(['status'])).stdout).toContain('acdevd (vsock cid')
      const shot = join(dir, 'screen.png')
      expect((await run(['screenshot', shot])).code).toBe(0)
      expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG')
    } finally {
      const stopped = await run(['stop'])
      expect(stopped.stderr).toMatch(/powered off|killed qemu|not running/)
    }
  }, 600_000)
})
