import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Machine } from '../../src/vm/machine.ts'
import { Forward } from '../../src/vm/forward.ts'
import { guestPassword, loginGuest, LoginRefused, prepareGuest, stageInGuest } from '../../src/vm/guest.ts'
import { connect } from 'node:net'
import { cleanup, collect, env, tmp } from '../helpers.ts'
import { CLI, IMAGE, QEMU, devLoop } from './helpers.ts'

afterAll(cleanup)

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

describe('acdev test --vm and DevTools in the guest, host side', () => {
  test('the session user gets the test password and a fresh faillock; its name and HOME come back', async () => {
    const ran: string[][] = []
    const devd = {
      run: async (argv: readonly string[], handlers: { stdout?: (chunk: Buffer) => void } = {}) => {
        ran.push([...argv])
        handlers.stdout?.(Buffer.from('dopame\n/home/dopame\n'))
        return 0
      },
    }
    expect(await prepareGuest(devd, 'pw')).toEqual({ user: 'dopame', home: '/home/dopame' })
    expect(ran[0]!.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(ran[0]!.slice(3)).toEqual(['sh', 'pw'])
    expect(ran[0]![2]).toContain('chpasswd')
    expect(ran[0]![2]).toContain('faillock --user "$user" --reset')
    expect(guestPassword({})).toBe('dopame-dev')
    expect(guestPassword({ ACDEV_VM_PASSWORD: 'other' })).toBe('other')
  })

  test('a guest that has no active session fails with what it said', async () => {
    const devd = {
      run: async (_argv: readonly string[], handlers: { stderr?: (chunk: Buffer) => void } = {}) => {
        handlers.stderr?.(Buffer.from('no session is active on seat0: log in in the guest first\n'))
        return 3
      },
    }
    await expect(prepareGuest(devd, 'pw')).rejects.toThrow('no session is active on seat0')
  })

  test('a forward hands every local connection to a tunnel to the guest port', async () => {
    const echo = createServer((socket) => socket.on('data', (chunk) => socket.write((chunk as Buffer).toString().toUpperCase())))
    await new Promise<void>((done) => echo.listen(0, '127.0.0.1', done))
    const target = (echo.address() as { port: number }).port
    const asked: number[] = []
    const forward = await Forward.open(9222, async (port) => {
      asked.push(port)
      return connect(target, '127.0.0.1')
    })
    try {
      const reply = await new Promise<string>((done) => {
        const socket = connect(forward.port, '127.0.0.1', () => socket.write('cdp'))
        socket.once('data', (chunk) => {
          done(chunk.toString())
          socket.destroy()
        })
      })
      expect(reply).toBe('CDP')
      expect(asked).toEqual([9222])
    } finally {
      forward.close()
      echo.close()
    }
  })
})

describe('acdev vm stop', () => {
  const ways = (answers: { devd?: boolean | Error; agent?: boolean | Error; acpi?: boolean | Error }, exitsAfter: string | null) => {
    const tried: string[] = []
    let last = ''
    const ask = (name: 'devd' | 'agent' | 'acpi') => async () => {
      tried.push(name)
      last = name
      const answer = answers[name] ?? false
      if (answer instanceof Error) throw answer
      return answer
    }
    return {
      tried,
      ways: {
        devd: ask('devd'),
        agent: ask('agent'),
        acpi: ask('acpi'),
        exited: async (seconds: number) => {
          tried.push(`wait ${seconds}`)
          return last === exitsAfter
        },
        kill: () => void tried.push('kill'),
      },
    }
  }

  test('when acdevd poweroff runs out its time, diagnostics are taken before the next way', async () => {
    const { tried, ways: given } = ways({ devd: true, agent: true }, 'agent')
    const diagnose = async () => void tried.push('diagnose')
    expect(await Machine.shutdown({ ...given, diagnose })).toBe('agent')
    const orderly = `wait ${Machine.ORDERLY_SECONDS}`
    expect(tried).toEqual(['devd', orderly, 'diagnose', 'agent', orderly])
    const quick = ways({ devd: true }, 'devd')
    expect(await Machine.shutdown({ ...quick.ways, diagnose: async () => void quick.tried.push('diagnose') })).toBe('devd')
    expect(quick.tried).not.toContain('diagnose')
    const failing = ways({ devd: true, agent: true }, 'agent')
    const broken = async () => {
      throw new Error('no agent')
    }
    expect(await Machine.shutdown({ ...failing.ways, diagnose: broken })).toBe('agent')
  })

  test('acdevd powers the guest off first and the others are not tried', async () => {
    const { tried, ways: given } = ways({ devd: true }, 'devd')
    expect(await Machine.shutdown(given)).toBe('devd')
    expect(tried).toEqual(['devd', `wait ${Machine.ORDERLY_SECONDS}`])
  })

  test('without acdevd the guest agent shuts it down', async () => {
    const { tried, ways: given } = ways({ devd: new Error('connect ENOENT'), agent: true }, 'agent')
    expect(await Machine.shutdown(given)).toBe('agent')
    expect(tried).toEqual(['devd', 'agent', `wait ${Machine.ORDERLY_SECONDS}`])
  })

  test('a guest that ignores both gets the ACPI button, then SIGTERM', async () => {
    const acpi = ways({ devd: true, agent: true, acpi: true }, 'acpi')
    expect(await Machine.shutdown(acpi.ways)).toBe('acpi')
    const orderly = `wait ${Machine.ORDERLY_SECONDS}`
    expect(acpi.tried).toEqual(['devd', orderly, 'agent', orderly, 'acpi', `wait ${Machine.ACPI_SECONDS}`])
    const none = ways({ devd: false, agent: new Error('no agent'), acpi: new Error('no qmp') }, null)
    expect(await Machine.shutdown(none.ways)).toBe('killed')
    expect(none.tried).toEqual(['devd', 'agent', 'acpi', 'kill'])
  })
})

describe('drop in the guest session', () => {
  const owner = Buffer.from('dopame\n/home/dopame\n1000\n')

  test('the host files are pushed under the user runtime folder and handed to the user', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'notes.md'), '# hi')
    const ran: string[][] = []
    const pushed: string[] = []
    const devd = {
      run: async (argv: readonly string[], handlers: { stdout?: (chunk: Buffer) => void } = {}) => {
        ran.push([...argv])
        if (ran.length === 1) handlers.stdout?.(owner)
        return 0
      },
      push: async (files: readonly { path: string }[]) => {
        pushed.push(...files.map((f) => f.path))
        return files.length
      },
    }
    const placed = await stageInGuest(devd, [join(dir, 'notes.md')])
    expect(placed).toHaveLength(1)
    expect(placed[0]).toMatch(/^\/run\/user\/1000\/acdev-drop\/[0-9a-f]{12}\/notes\.md$/)
    expect(pushed).toEqual(placed)
    expect(ran[1]!.slice(3)).toEqual(['sh', 'dopame', '/run/user/1000/acdev-drop'])
    expect(ran[1]![2]).toContain('chown -R')
  })

  test('a push that fails is an error, not a drop', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.txt'), 'a')
    const devd = {
      run: async (_argv: readonly string[], handlers: { stdout?: (chunk: Buffer) => void } = {}) => {
        handlers.stdout?.(owner)
        return 0
      },
      push: async () => {
        throw new Error('acdevd: No space left on device')
      },
    }
    await expect(stageInGuest(devd, [join(dir, 'a.txt')])).rejects.toThrow('drop: could not put the files into the guest: acdevd: No space left')
  })
})

describe('acdev vm login', () => {
  const fake = (code: number, stderr = '') => {
    const pushed: { path: string; mode: number; data: string }[] = []
    const ran: string[][] = []
    const devd = {
      push: async (files: readonly { path: string; mode: number; data: Buffer }[]) => {
        pushed.push(...files.map((f) => ({ path: f.path, mode: f.mode, data: f.data.toString() })))
        return files.length
      },
      run: async (argv: readonly string[], handlers: { stdout?: (b: Buffer) => void; stderr?: (b: Buffer) => void } = {}) => {
        ran.push([...argv])
        if (code === 0) handlers.stdout?.(Buffer.from('logged in: tester\n'))
        if (stderr) handlers.stderr?.(Buffer.from(stderr))
        return code
      },
    }
    return { devd, pushed, ran }
  }

  test('the password goes in a 0600 file, never on a command line; acdes reads it on stdin', async () => {
    const { devd, pushed, ran } = fake(0)
    expect(await loginGuest(devd as never, 'tester', 'pw')).toBe('logged in: tester')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.mode).toBe(0o600)
    expect(pushed[0]!.data).toBe('pw\n')
    expect(ran[0]!.join(' ')).not.toContain('pw')
    expect(ran[0]!.slice(-2)).toEqual(['tester', pushed[0]!.path])
    expect(ran[0]![2]).toContain('acdes greeter login "$1" < "$2"')
  })

  test('each exit code of acdes greeter login says what went wrong', async () => {
    for (const [code, said] of [[1, 'turned the password down'], [2, 'not a guest acdev started'], [3, 'no login page is waiting']] as const) {
      const error = await loginGuest(fake(code, 'detail').devd as never, 'tester', 'pw').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(LoginRefused)
      expect((error as LoginRefused).code).toBe(code)
      expect((error as Error).message).toContain(said)
    }
  })
})
