import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { which } from '../launcher.mjs'
import { GuestAgent, monitor } from '../src/vm/channel.ts'
import { Machine } from '../src/vm/machine.ts'
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

describe('the QEMU command line', () => {
  test('KVM, virtio display, keyboard and tablet, the serial log, the share', () => {
    const machine = new Machine({ ACDE_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({ display: 'none', share: '/srv/out' }, true).join(' ')
    for (const part of ['-accel kvm', '-device virtio-vga', '-device virtio-keyboard-pci', '-device virtio-tablet-pci',
      '-display none', `path=${machine.serial}`, 'local,path=/srv/out,mount_tag=acdev', 'file=/c.fd']) {
      expect(args).toContain(part)
    }
    expect(machine.args({}, false).join(' ')).toContain('-accel tcg,thread=multi -cpu max -smp')
    expect(machine.args({ gl: true }, true).join(' ')).toContain('-device virtio-vga-gl -display gtk,gl=on')
  })

  test('acdev vm: an unknown subcommand, and stop or status with no guest', async () => {
    const dir = tmp()
    const run = (args: string[]) => collect([process.execPath, CLI, 'vm', ...args], { cwd: dir, env: env({ ACDE_VM_DIR: dir }) })
    const unknown = await run(['bogus'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown subcommand "bogus": fetch, start, stop')
    expect((await run(['stop'])).stderr).toBe('acdev vm: not running\n')
    expect((await run(['status'])).stdout).toContain('guest: not running')
    expect((await run(['run', 'true'])).stderr).toContain(`no guest is running from ${dir}`)
  })
})

const IMAGE = process.env['ACDE_VM_TEST_IMAGE'] ?? ''
const QEMU = which('qemu-system-x86_64') !== null && Machine.kvm() && IMAGE !== '' && existsSync(IMAGE)

describe('a real guest (ACDE_VM_TEST_IMAGE, QEMU and KVM)', () => {
  test.skipIf(!QEMU)('start --headless waits until ready; run, push, screenshot; stop', async () => {
    const dir = tmp()
    const run = (args: string[]) => collect([process.execPath, CLI, 'vm', ...args], { cwd: dir, env: env({ ACDE_VM_DIR: dir }) })
    try {
      const started = await run(['start', '--headless', '--image', IMAGE])
      expect(started.code, started.out).toBe(0)
      expect(started.stderr).toContain('the guest is ready')
      const ran = await run(['run', '--', 'echo hello; exit 3'])
      expect(ran.code).toBe(3)
      expect(ran.stdout).toBe('hello\n')
      expect((await run(['push', CLI, '/opt/acdev/cli.ts'])).code).toBe(0)
      expect((await run(['run', 'cmp -s /opt/acdev/cli.ts /dev/null; wc -c < /opt/acdev/cli.ts'])).stdout.trim())
        .toBe(String(readFileSync(CLI).length))
      const shot = join(dir, 'screen.png')
      expect((await run(['screenshot', shot])).code).toBe(0)
      expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG')
    } finally {
      const stopped = await run(['stop'])
      expect(stopped.stderr).toMatch(/powered off|killed qemu|not running/)
    }
  }, 600_000)
})
