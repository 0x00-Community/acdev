import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { which } from '../launcher.mjs'
import { GuestAgent, monitor, relayed } from '../src/vm/channel.ts'
import { Devd, encode, Frames, Kind, SocketTransport, type Frame, type Transport } from '../src/vm/devd.ts'
import { crateBinary, crateVersion } from '../src/vm/binary.ts'
import { accelArgs, bundledFirmware, findQemu, missingFeatures, preferredAccel, qemuDirs } from '../src/vm/host.ts'
import { defaultLink, Machine } from '../src/vm/machine.ts'
import { DEVD_LOGS, LineFilter, logCommand } from '../src/vm/logs.ts'
import { BIN, executables, profileFor, snapshot, startCommand } from '../src/vm/loop.ts'
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
  readonly answer: (sent: Frame[]) => Frame[]

  constructor(answer: (sent: Frame[]) => Frame[]) {
    this.answer = answer
  }

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

  test('pull writes each file under LOCAL with its mode; a single file lands at LOCAL; .. is refused', async () => {
    const dir = tmp()
    const header = (mode: number, name: string) => Buffer.concat([u32(mode), Buffer.from(name)])
    const tree = new Scripted(() => [frame(Kind.PUSH, header(0o755, 'sub/run.sh')), frame(Kind.DATA, Buffer.from('echo ')),
      frame(Kind.DATA, Buffer.from('hi')), frame(Kind.END), frame(Kind.PUSH, header(0o600, 'b.txt')), frame(Kind.END), frame(Kind.OK, u32(2))])
    expect(await new Devd(tree).pull('/srv/out', join(dir, 'out'))).toBe(2)
    expect([tree.sent[0]!.kind, tree.sent[0]!.body.toString()]).toEqual([Kind.PULL, '/srv/out'])
    expect(readFileSync(join(dir, 'out', 'sub', 'run.sh'), 'utf8')).toBe('echo hi')
    expect(statSync(join(dir, 'out', 'sub', 'run.sh')).mode & 0o777).toBe(0o755)
    expect(statSync(join(dir, 'out', 'b.txt')).mode & 0o777).toBe(0o600)
    const one = new Scripted(() => [frame(Kind.PUSH, header(0o644, '')), frame(Kind.DATA, Buffer.from('png')), frame(Kind.END), frame(Kind.OK, u32(1))])
    expect(await new Devd(one).pull('/tmp/shot.png', join(dir, 'shot.png'))).toBe(1)
    expect(readFileSync(join(dir, 'shot.png'), 'utf8')).toBe('png')
    const climbing = new Scripted(() => [frame(Kind.PUSH, header(0o644, '../evil')), frame(Kind.END), frame(Kind.OK, u32(1))])
    await expect(new Devd(climbing).pull('/srv', join(dir, 'in'))).rejects.toThrow('outside the pulled directory')
    expect(existsSync(join(dir, 'evil'))).toBe(false)
  })

  test('pull keeps only the permission bits, and an error midway leaves no half file', async () => {
    const dir = tmp()
    const header = (mode: number, name: string) => Buffer.concat([u32(mode), Buffer.from(name)])
    const setuid = new Scripted(() => [frame(Kind.PUSH, header(0o4755, '')), frame(Kind.END), frame(Kind.OK, u32(1))])
    expect(await new Devd(setuid).pull('/usr/bin/su', join(dir, 'su'))).toBe(1)
    expect(statSync(join(dir, 'su')).mode & 0o7777).toBe(0o755)
    const broken = new Scripted(() => [frame(Kind.PUSH, header(0o644, '')), frame(Kind.DATA, Buffer.from('half')),
      frame(Kind.ERROR, Buffer.from('read failed'))])
    await expect(new Devd(broken).pull('/var/big', join(dir, 'big'))).rejects.toThrow('acdevd: read failed')
    expect([existsSync(join(dir, 'big')), existsSync(join(dir, 'big.acdev-part'))]).toEqual([false, false])
  })

  test('a socket that does not connect gives an error, not a crash', async () => {
    const devd = new Devd(new SocketTransport({ path: join(tmp(), 'nobody.sock') }), Buffer.from('k'))
    await expect(devd.version()).rejects.toThrow(/ENOENT|ECONNREFUSED|no such/i)
  })

  test('with a key every connection starts with it', async () => {
    const transport = new Scripted((sent) => (sent.length < 2 ? [] : [frame(Kind.OK, Buffer.from('0.3.0'))]))
    expect(await new Devd(transport, Buffer.from('k3y')).version()).toBe('0.3.0')
    expect(transport.sent.map((f) => [f.kind, f.body.toString()])).toEqual([[Kind.AUTH, 'k3y'], [Kind.VERSION, '']])
  })

  test('a socket transport speaks the frames over a Unix socket', async () => {
    const path = join(tmp(), 'devd.sock')
    const seen: string[] = []
    const server = createServer((socket) => {
      const decoder = new Frames()
      socket.on('data', (chunk) => {
        for (const got of decoder.push(chunk as Buffer)) {
          seen.push(got.kind)
          if (got.kind === Kind.VERSION) socket.end(encode(Kind.OK, Buffer.from('9.9.9')))
        }
      })
    })
    await new Promise<void>((done) => server.listen(path, done))
    try {
      expect(await new Devd(new SocketTransport({ path }), Buffer.from('k')).version()).toBe('9.9.9')
      expect(seen).toEqual([Kind.AUTH, Kind.VERSION])
    } finally {
      server.close()
    }
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

describe('acdev vm dev', () => {
  const artifact = (name: string, kind: string, executable: string | null) =>
    JSON.stringify({ reason: 'compiler-artifact', target: { name, kind: [kind] }, executable })

  test('the binaries come from cargo\'s artifacts, only those asked for; a missing one is an error', () => {
    const lines = [artifact('detour', 'lib', null), artifact('winman', 'bin', '/t/winman'), 'Compiling ...',
      artifact('winman-test-client', 'bin', '/t/winman-test-client'), JSON.stringify({ reason: 'build-finished', success: true })]
    expect(executables(lines, [])).toEqual([{ name: 'winman', path: '/t/winman' },
      { name: 'winman-test-client', path: '/t/winman-test-client' }])
    expect(executables(lines, ['winman-test-client'])).toEqual([{ name: 'winman-test-client', path: '/t/winman-test-client' }])
    expect(() => executables(lines, ['nope'])).toThrow('cargo built no binary nope')
  })

  test('the guest profile when the project has one, else release', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "a"\n\n[profile.release]\ndebug = 1\n')
    expect(profileFor(dir)).toBe('release')
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "a"\n\n[profile.guest]\ninherits = "release"\n')
    expect(profileFor(dir)).toBe('guest')
  })

  test('a change to a source file shows, one under target does not; the program runs from the pushed binaries', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'target'))
    writeFileSync(join(dir, 'src', 'main.rs'), 'fn main() {}')
    const before = snapshot(dir)
    writeFileSync(join(dir, 'target', 'out'), 'x')
    expect(snapshot(dir)).toBe(before)
    utimesSync(join(dir, 'src', 'main.rs'), new Date(), new Date(Date.now() + 5000))
    expect(snapshot(dir)).not.toBe(before)
    const built = [{ name: 'winman', path: '/t/winman' }]
    expect(startCommand({ dir, bins: [], run: null }, built)).toBe(`export PATH=${BIN}:$PATH; winman`)
    expect(startCommand({ dir, bins: [], run: 'winman --card /dev/dri/card1 winman-test-client' }, built))
      .toBe(`export PATH=${BIN}:$PATH; winman --card /dev/dri/card1 winman-test-client`)
  })
})

describe('the QEMU command line', () => {
  test('KVM, virtio display, keyboard and tablet, the serial log, the share', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({ display: 'none', share: '/srv/out' }, 'kvm').join(' ')
    for (const part of ['-accel kvm', '-device virtio-vga', '-device virtio-keyboard-pci', '-device virtio-tablet-pci',
      '-display none', `path=${machine.serial}`, `vhost-vsock-pci,guest-cid=${machine.cid()}`, 'local,path=/srv/out,mount_tag=acdev', 'file=/c.fd']) {
      expect(args).toContain(part)
    }
    expect(machine.args({}, 'tcg').join(' ')).toContain('-accel tcg,thread=multi -cpu max -smp')
    expect(machine.args({ gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0 -display gtk,gl=on')
    expect(args).toContain(`-fw_cfg name=opt/acdev/key,file=${machine.key}`)
  })

  test('--viewer gives QEMU a peer-to-peer D-Bus display; the viewer binary comes from ACDEV_VIEWER', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    expect(machine.args({ display: 'viewer' }, 'kvm').join(' ')).toContain('-display dbus,p2p=yes')
    const wanted = { crate: 'viewer', name: 'acdev-viewer', variable: 'ACDEV_VIEWER' }
    expect(crateBinary(Machine.ROOT, wanted, { ACDEV_VIEWER: CLI })).toBe(CLI)
    expect(() => crateBinary(Machine.ROOT, wanted, { ACDEV_VIEWER: '/no/such/viewer' })).toThrow('ACDEV_VIEWER=/no/such/viewer: no such file')
  })

  test('--outputs N gives the display device N heads; one is the default', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const one = machine.args({}, 'kvm').join(' ')
    expect(one).toContain('-device virtio-vga,id=gpu0 ')
    expect(one).not.toContain('max_outputs')
    expect(machine.args({ outputs: 2 }, 'kvm').join(' ')).toContain('-device virtio-vga,id=gpu0,max_outputs=2 ')
    expect(machine.args({ outputs: 3, gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0,max_outputs=3 ')
    expect(machine.args({ display: 'none' }, 'kvm').join(' ')).toContain('-display none')
    expect(machine.args({ display: 'none', outputs: 2 }, 'kvm').join(' ')).toContain('-display dbus,p2p=yes')
  })

  test('two PCIe root ports, rp1 and rp2, take hot-plugged devices', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({}, 'kvm').join(' ')
    expect(args).toContain('-device pcie-root-port,id=rp1,bus=pcie.0,chassis=11,slot=11')
    expect(args).toContain('-device pcie-root-port,id=rp2,bus=pcie.0,chassis=12,slot=12')
  })

  test('acdevd: ACDEV_DEVD, then CARGO_TARGET_DIR, then logs/cargo-target/acdev-devd above, then the crate\'s target', () => {
    const base = tmp()
    const root = join(base, 'repo', 'npm')
    const wanted = { crate: 'devd', name: 'acdevd', variable: 'ACDEV_DEVD', shared: 'acdev-devd' }
    const place = (dir: string) => {
      mkdirSync(join(dir, 'release'), { recursive: true })
      writeFileSync(join(dir, 'release', 'acdevd'), '')
      return join(dir, 'release', 'acdevd')
    }
    const own = place(join(base, 'repo', 'crates', 'devd', 'target'))
    expect(crateBinary(root, wanted, {})).toBe(own)
    const shared = place(join(base, 'logs', 'cargo-target', 'acdev-devd'))
    expect(crateBinary(root, wanted, {})).toBe(shared)
    const configured = place(join(base, 'elsewhere'))
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere') })).toBe(configured)
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere'), ACDEV_DEVD: own })).toBe(own)
  })

  test('an acdevd of another version is refused before it goes into the guest', () => {
    const dir = tmp()
    const fake = (version: string) => {
      const path = join(dir, `acdevd-${version}`)
      writeFileSync(path, `#!/bin/sh\necho "acdevd ${version}"\n`, { mode: 0o755 })
      return path
    }
    const want = crateVersion(Machine.ROOT, 'devd')!
    expect(() => Devd.checkVersion(fake(want), Machine.ROOT)).not.toThrow()
    expect(() => Devd.checkVersion(fake('0.1.0'), Machine.ROOT)).toThrow(`is acdevd 0.1.0, this acdev needs ${want}: rebuild it`)
  })

  test('start checks acdevd\'s version before it starts QEMU', async () => {
    const dir = tmp()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    script('qemu-system-x86_64', `touch ${join(dir, 'qemu-ran')}`)
    script('qemu-img', 'exit 0')
    script('acdevd-old', 'echo "acdevd 0.0.1"')
    writeFileSync(join(dir, 'image.qcow2'), '')
    const started = await collect([process.execPath, CLI, 'vm', 'start', '--headless', '--image', join(dir, 'image.qcow2')], {
      cwd: dir,
      env: env({ ACDEV_VM_DIR: join(dir, 'vm'), ACDEV_DEVD: join(bin, 'acdevd-old'), PATH: `${bin}:${process.env['PATH']}`,
        OVMF_CODE: join(dir, 'image.qcow2'), OVMF_VARS: join(dir, 'image.qcow2') }),
    })
    expect(started.code).toBe(1)
    expect(started.stderr).toContain('is acdevd 0.0.1, this acdev needs')
    expect(existsSync(join(dir, 'qemu-ran'))).toBe(false)
  })

  test('a forwarded link replaces vsock with a hostfwd to acdevd\'s port', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const unix = machine.args({}, 'kvm', { kind: 'unix', path: '/r/devd.sock' }).join(' ')
    expect(unix).toContain('user,model=virtio-net-pci,hostfwd=unix:/r/devd.sock-:5252')
    expect(unix).not.toContain('vhost-vsock')
    expect(machine.args({}, 'kvm', { kind: 'tcp', port: 4321 }).join(' ')).toContain(',hostfwd=tcp:127.0.0.1:4321-:5252')
    expect(new Machine({ ACDEV_VM_TRANSPORT: 'unix' }).linkKind()).toBe('unix')
    expect(['linux', 'darwin', 'win32', 'freebsd'].map((p) => defaultLink(p as NodeJS.Platform))).toEqual(['vsock', 'tcp', 'tcp', 'tcp'])
    expect(() => new Machine({ ACDEV_VM_TRANSPORT: 'usb' }).linkKind()).toThrow('vsock, unix, tcp')
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
    expect((await run(['view'])).stderr).toContain(`no guest is running from ${dir}`)
    expect((await run(['start', '--outputs', '0'])).stderr).toContain('--outputs 0: a whole number from 1 to 16')
    expect((await run(['start', '--outputs', '2.5'])).stderr).toContain('--outputs 2.5: a whole number from 1 to 16')
    expect((await run(['start', '--outputs', '2', '--viewer'])).stderr).toContain('--viewer shows only the first output')
    expect((await run(['screenshot', 'x.png', '--output', '1.5'])).stderr).toContain('--output 1.5: a whole number from 0 to 15')
    expect((await run(['start', '--headless', '--viewer'])).stderr).toContain('one of --headless, --vnc, --viewer, not --headless and --viewer')
  })
})

const IMAGE = process.env['ACDEV_VM_TEST_IMAGE'] ?? ''
const QEMU = which('qemu-system-x86_64') !== null && Machine.kvm() && IMAGE !== '' && existsSync(IMAGE)

async function devLoop(vmDir: string): Promise<string[]> {
  const project = join(vmDir, 'hello')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "hello"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n')
  const source = (word: string) => writeFileSync(join(project, 'src', 'main.rs'),
    `fn main() { println!("${word}"); std::thread::sleep(std::time::Duration::from_secs(600)); }\n`)
  source('v1')
  const child = spawn(process.execPath, [CLI, 'vm', 'dev', project], { env: env({ ACDEV_VM_DIR: vmDir }), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  const seen = async (word: string) => {
    for (let waited = 0; !out.includes(word); waited += 500) {
      if (waited > 240_000) throw new Error(`no ${word} from acdev vm dev: ${out}`)
      await new Promise((tick) => setTimeout(tick, 500))
    }
    return word
  }
  try {
    const words = [await seen('v1')]
    source('v2')
    words.push(await seen('v2'))
    return words
  } finally {
    child.kill('SIGINT')
    await new Promise((done) => child.on('close', done))
  }
}

describe('a real guest (ACDEV_VM_TEST_IMAGE, QEMU and KVM)', () => {
  test.skipIf(!QEMU)('start --headless, acdevd ready; run, push, detach, logs, kill, shell, dev loop, wrong key, screenshot, pull; stop', async () => {
    const dir = tmp()
    const run = (args: string[]) => collect([process.execPath, CLI, 'vm', ...args], { cwd: dir, env: env({ ACDEV_VM_DIR: dir }) })
    try {
      const started = await run(['start', '--headless', '--image', IMAGE])
      expect(started.code, started.out).toBe(0)
      expect(started.stderr).toContain('answers over')
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
      expect(await devLoop(dir)).toEqual(['v1', 'v2'])
      expect((await run(['status'])).stdout).toContain(`acdevd (over ${new Machine({ ACDEV_VM_DIR: dir }).describeLink()}): `)
      const key = join(dir, 'run', 'key')
      const real = readFileSync(key)
      writeFileSync(key, 'not-the-key\n')
      expect((await run(['status'])).stdout).toContain('not answering (acdevd: wrong key)')
      writeFileSync(key, real)
      const shot = join(dir, 'screen.png')
      expect((await run(['screenshot', shot])).code).toBe(0)
      expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG')
      expect((await run(['push', shot, '/tmp/acdev-pull/shots/screen.png'])).code).toBe(0)
      const copy = 'mkdir -p /tmp/acdev-pull/bin && cp /opt/acdev/cli.ts /tmp/acdev-pull/bin/ && chmod 750 /tmp/acdev-pull/bin/cli.ts'
      expect((await run(['run', copy])).code).toBe(0)
      const back = join(dir, 'back')
      mkdirSync(back)
      const pulled = await run(['pull', '/tmp/acdev-pull', back])
      expect(pulled.code, pulled.out).toBe(0)
      expect(pulled.stderr).toContain('(2 files)')
      expect(readFileSync(join(back, 'acdev-pull', 'shots', 'screen.png'))).toEqual(readFileSync(shot))
      expect(readFileSync(join(back, 'acdev-pull', 'bin', 'cli.ts'))).toEqual(readFileSync(CLI))
      expect(statSync(join(back, 'acdev-pull', 'bin', 'cli.ts')).mode & 0o777).toBe(0o750)
      expect((await run(['pull', '/tmp/acdev-pull/shots/screen.png', join(dir, 'one.png')])).code).toBe(0)
      expect(readFileSync(join(dir, 'one.png'))).toEqual(readFileSync(shot))
    } finally {
      const stopped = await run(['stop'])
      expect(stopped.stderr).toMatch(/powered off|killed qemu|not running/)
    }
  }, 600_000)
})

describe('hosts other than Linux (only the parts that run here)', () => {
  const windows = { platform: 'win32', arch: 'x64' } as const
  const mac = { platform: 'darwin', arch: 'x64' } as const

  test('the accelerator: KVM when /dev/kvm opens, WHPX on Windows, HVF on macOS, else TCG; WHPX takes -cpu max', () => {
    expect(preferredAccel({ platform: 'linux', arch: 'x64' }, true)).toBe('kvm')
    expect(preferredAccel({ platform: 'linux', arch: 'x64' }, false)).toBe('tcg')
    expect(preferredAccel(windows, false)).toBe('whpx')
    expect(preferredAccel(mac, false)).toBe('hvf')
    expect(accelArgs('whpx')).toEqual(['-accel', 'whpx', '-cpu', 'max'])
    expect(accelArgs('hvf')).toEqual(['-accel', 'hvf', '-cpu', 'host'])
    expect(accelArgs('tcg')).toEqual(['-accel', 'tcg,thread=multi', '-cpu', 'max'])
  })

  test('QEMU on Windows: ACDEV_QEMU_DIR, PATH, the registry, Program Files, MSYS2, in that order', () => {
    const env = { PATH: 'C:\\tools;C:\\bin', ProgramFiles: 'D:\\Programs' }
    expect(qemuDirs({ host: windows, env, registry: () => 'E:\\qemu' }))
      .toEqual(['C:\\tools', 'C:\\bin', 'E:\\qemu', 'D:\\Programs\\qemu', 'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin'])
    const there = new Set(['D:\\Programs\\qemu\\qemu-system-x86_64.exe', 'D:\\Programs\\qemu\\qemu-img.exe'])
    const qemu = findQemu({ host: windows, env, registry: () => null, exists: (path) => there.has(path) }, 'x86_64')
    expect(qemu).toEqual({ system: 'D:\\Programs\\qemu\\qemu-system-x86_64.exe', img: 'D:\\Programs\\qemu\\qemu-img.exe' })
    expect(bundledFirmware(windows, qemu, 'x86_64'))
      .toEqual(['D:\\Programs\\qemu\\share\\edk2-x86_64-code.fd', 'D:\\Programs\\qemu\\share\\edk2-i386-vars.fd'])
    const given = qemuDirs({ host: windows, env: { ...env, ACDEV_QEMU_DIR: 'F:\\q' }, registry: () => null })
    expect(given[0]).toBe('F:\\q')
    expect(() => findQemu({ host: windows, env, registry: () => null, exists: () => false }, 'x86_64')).toThrow('qemu.weilnetz.de')
  })

  test('QEMU on macOS: PATH, then Homebrew on Apple silicon and Intel, then MacPorts; its share/qemu firmware', () => {
    expect(qemuDirs({ host: mac, env: { PATH: '/usr/bin' } })).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'])
    expect(bundledFirmware(mac, { system: '/usr/local/bin/qemu-system-x86_64', img: '/usr/local/bin/qemu-img' }, 'x86_64'))
      .toEqual(['/usr/local/share/qemu/edk2-x86_64-code.fd', '/usr/local/share/qemu/edk2-i386-vars.fd'])
  })

  test('on Windows QMP and the guest agent are Unix sockets in run/ too; --share and the viewer are refused', async () => {
    const dir = tmp()
    const temp = tmp()
    const machine = new Machine({ ACDEV_VM_DIR: dir, TEMP: temp, OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, windows)
    const args = machine.args({}, 'whpx', { kind: 'tcp', port: 4003 }).join(' ')
    expect(dirname(machine.qmp)).toMatch(/[\\/]acdev-[0-9a-f]{12}$/)
    expect(machine.qmp.startsWith(temp)).toBe(true)
    expect(machine.accelerator()).toBe('WHPX (the Windows Hypervisor Platform feature); TCG if it does not start')
    expect(args).toContain('-accel whpx -cpu max')
    expect(args).toContain(`-qmp unix:${machine.qmp},server=on,wait=off`)
    expect(args).toContain(`-chardev socket,path=${machine.qga},server=on,wait=off,id=qga0`)
    expect(args).toContain('hostfwd=tcp:127.0.0.1:4003-:5252')
    expect(machine.linkKind()).toBe('tcp')
    await expect(machine.start({ share: 'C:\\src' }, () => undefined)).rejects.toThrow('use acdev vm push')
    await expect(machine.start({ display: 'viewer' }, () => undefined)).rejects.toThrow('Linux only for now')
    expect(() => machine.devdBinary()).toThrow('set ACDEV_DEVD to an acdevd built for the guest (Linux x86_64)')
  })

  test('acdev-relay: ACDEV_RELAY, then CARGO_TARGET_DIR, then the crate\'s target; its failure ends the stream, not acdev', async () => {
    const base = tmp()
    const root = join(base, 'repo', 'npm')
    const wanted = { crate: 'relay', name: 'acdev-relay', variable: 'ACDEV_RELAY' }
    const place = (dir: string) => {
      mkdirSync(join(dir, 'release'), { recursive: true })
      writeFileSync(join(dir, 'release', 'acdev-relay'), '')
      return join(dir, 'release', 'acdev-relay')
    }
    const own = place(join(base, 'repo', 'crates', 'relay', 'target'))
    expect(crateBinary(root, wanted, {})).toBe(own)
    const configured = place(join(base, 'elsewhere'))
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere') })).toBe(configured)
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere'), ACDEV_RELAY: own })).toBe(own)
    const failing = join(base, 'failing-relay')
    writeFileSync(failing, '#!/bin/sh\necho "acdev-relay: $1: connection refused" >&2\nexit 1\n', { mode: 0o755 })
    const stream = relayed('/no/such.sock', { ACDEV_RELAY: failing })
    const error = await new Promise<Error>((done) => stream.once('error', done))
    expect(error.message).toBe('acdev-relay: /no/such.sock: connection refused')
  })

  test('on an Intel Mac: HVF with the host CPU, QEMU\'s Cocoa window, a forwarded TCP port; Apple silicon waits for 04', async () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, mac)
    const args = machine.args({}, 'hvf', { kind: 'tcp', port: 4005 }).join(' ')
    expect(args).toContain('-machine q35 -accel hvf -cpu host')
    expect(args).toContain('-display cocoa')
    expect(args).toContain('-qmp unix:')
    expect(args).not.toContain('vhost-vsock')
    expect(machine.linkKind()).toBe('tcp')
    await expect(machine.start({ gl: true }, () => undefined)).rejects.toThrow('Linux only')
    const silicon = new Machine({ ACDEV_VM_DIR: tmp() }, { platform: 'darwin', arch: 'arm64' })
    await expect(silicon.start({}, () => undefined)).rejects.toThrow('work item 04')
  })

  test('the guest CPU must have the x86-64-v3 features', () => {
    const flags = 'flags\t\t: fpu sse4_2 avx avx2 bmi1 bmi2 f16c fma abm movbe xsave\n'
    expect(missingFeatures(flags)).toEqual([])
    expect(missingFeatures('flags\t: fpu sse4_2 avx xsave\n')).toEqual(['avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe'])
  })
})
