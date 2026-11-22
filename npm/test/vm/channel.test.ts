import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { GuestAgent, monitor } from '../../src/vm/channel.ts'
import { Devd, encode, Frames, Kind, SocketTransport } from '../../src/vm/devd.ts'
import { DEVD_LOGS, LineFilter, logCommand } from '../../src/vm/logs.ts'
import { BIN, executables, profileFor, snapshot, startCommand } from '../../src/vm/loop.ts'
import { cleanup, tmp } from '../helpers.ts'
import { serve, reply, Scripted, frame, u32 } from './helpers.ts'

afterAll(cleanup)

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

  test('push modes: the execute bits on unix; on Windows, which has none, ELF files and #! scripts are 755', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), { mode: 0o644 })
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o644 })
    writeFileSync(join(dir, 'notes.txt'), 'ELF #!', { mode: 0o755 })
    const modes = (platform: NodeJS.Platform) => Object.fromEntries(Devd.files(dir, '/opt/d', platform).map((f) => [f.path, f.mode]))
    expect(modes('win32')).toEqual({ '/opt/d/tool': 0o755, '/opt/d/run.sh': 0o755, '/opt/d/notes.txt': 0o644 })
    expect(modes('linux')).toEqual({ '/opt/d/tool': 0o644, '/opt/d/run.sh': 0o644, '/opt/d/notes.txt': 0o755 })
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

  test('a tunnel answers OK, then carries raw bytes both ways, including bytes sent along with the OK', async () => {
    const path = join(tmp(), 'tunnel.sock')
    const asked: string[] = []
    const server = createServer((socket) => {
      const decoder = new Frames()
      socket.on('data', (chunk) => {
        if (asked.length >= 2) return void socket.write((chunk as Buffer).toString().toUpperCase())
        for (const got of decoder.push(chunk as Buffer)) {
          asked.push(`${got.kind} ${got.body.toString()}`)
          if (got.kind === Kind.SOCKET) socket.write(Buffer.concat([encode(Kind.OK), Buffer.from('hello ')]))
        }
      })
    })
    await new Promise<void>((done) => server.listen(path, done))
    try {
      const tunnel = await new Devd(new SocketTransport({ path }), Buffer.from('k')).socket('/run/user/1000/acde/dev.sock')
      let seen = ''
      const heard = new Promise<void>((done) => tunnel.on('data', (chunk: Buffer) => {
        seen += chunk.toString()
        if (seen === 'hello PING') done()
      }))
      tunnel.write('ping')
      await heard
      tunnel.destroy()
      expect(asked).toEqual([`${Kind.AUTH} k`, `${Kind.SOCKET} /run/user/1000/acde/dev.sock`])
    } finally {
      server.close()
    }
  })

  test('a refused tunnel rejects with what acdevd said', async () => {
    const port = Buffer.alloc(2)
    port.writeUInt16LE(9222, 0)
    const refused = new Scripted(() => [frame(Kind.ERROR, Buffer.from('a tunnel needs a key'))])
    await expect(new Devd(refused).tcp(9222)).rejects.toThrow('acdevd: a tunnel needs a key')
    expect(refused.sent).toEqual([frame(Kind.TCP, port)])
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
    filter.push(Buffer.from('acompositor: Frame 1\nother\nacompositor: fra'))
    filter.push(Buffer.from('me 2\nlast frame'))
    filter.end()
    expect(seen).toEqual(['acompositor: Frame 1\n', 'acompositor: frame 2\n', 'last frame\n'])
    const all: string[] = []
    new LineFilter(undefined, (text) => all.push(text)).push(Buffer.from('as is'))
    expect(all).toEqual(['as is'])
  })
})

describe('acdev vm dev', () => {
  const artifact = (name: string, kind: string, executable: string | null) =>
    JSON.stringify({ reason: 'compiler-artifact', target: { name, kind: [kind] }, executable })

  test('the binaries come from cargo\'s artifacts, only those asked for; a missing one is an error', () => {
    const lines = [artifact('detour', 'lib', null), artifact('acompositor', 'bin', '/t/acompositor'), 'Compiling ...',
      artifact('acompositor-test-client', 'bin', '/t/acompositor-test-client'), JSON.stringify({ reason: 'build-finished', success: true })]
    expect(executables(lines, [])).toEqual([{ name: 'acompositor', path: '/t/acompositor' },
      { name: 'acompositor-test-client', path: '/t/acompositor-test-client' }])
    expect(executables(lines, ['acompositor-test-client'])).toEqual([{ name: 'acompositor-test-client', path: '/t/acompositor-test-client' }])
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
    const built = [{ name: 'acompositor', path: '/t/acompositor' }]
    expect(startCommand({ dir, bins: [], run: null }, built)).toBe(`export PATH=${BIN}:$PATH; acompositor`)
    expect(startCommand({ dir, bins: [], run: 'acompositor --card /dev/dri/card1 acompositor-test-client' }, built))
      .toBe(`export PATH=${BIN}:$PATH; acompositor --card /dev/dri/card1 acompositor-test-client`)
  })
})
