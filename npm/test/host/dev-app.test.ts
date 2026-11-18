import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, skipping, tmp } from '../helpers.ts'

const CLI = join(import.meta.dir, '../../src/cli.ts')
const APP = join(import.meta.dir, '../fixtures/host/hello')
const RUNTIME = process.env['ACDEV_RUNTIME'] ?? ''
const WANTED = process.env['ACDEV_HOST_E2E'] === '1'
const START_MS = 120_000

const skip = skipping(!WANTED || !RUNTIME, 'host e2e: set ACDEV_HOST_E2E=1 and ACDEV_RUNTIME to a real acdev runtime (bun run test:host)')

interface Ran {
  readonly code: number
  readonly out: string
}

describe.skipIf(skip)('acdev dev --app on the host, driven through the CLI against the real runtime', () => {
  let project = ''
  let env: Record<string, string> = {}
  let dev: ReturnType<typeof Bun.spawn> | null = null

  const acdev = async (args: string[]): Promise<Ran> => {
    const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: project, env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out: stdout + stderr }
  }

  const until = async (what: string, args: string[], done: (ran: Ran) => boolean): Promise<Ran> => {
    const deadline = Date.now() + START_MS
    let last: Ran | null = null
    while (Date.now() < deadline) {
      if (dev && dev.exitCode !== null) throw new Error(`acdev dev exited (${dev.exitCode}) before ${what}`)
      last = await acdev(args)
      if (done(last)) return last
      await Bun.sleep(1000)
    }
    throw new Error(`${what} did not happen within ${START_MS / 1000} s; acdev ${args.join(' ')} last said (${last?.code}): ${last?.out}`)
  }

  beforeAll(async () => {
    const home = tmp()
    project = join(home, 'hello')
    cpSync(APP, project, { recursive: true })
    const runtimeDir = join(home, 'run')
    mkdirSync(runtimeDir, { mode: 0o700 })
    env = {
      ...process.env as Record<string, string>,
      ACDEV_RUNTIME: RUNTIME,
      ACDEV_BROWSER: 'none',
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
    }
    dev = Bun.spawn([process.execPath, CLI, 'dev', project, '--app', 'hello-backend', '--headless', '--force'], {
      cwd: project, env, stdout: Bun.file(join(home, 'dev.out.log')), stderr: Bun.file(join(home, 'dev.err.log')),
    })
    await until('the page to show in acdev webs', ['webs'], (ran) => ran.code === 0 && ran.out.includes('hello-backend'))
  }, START_MS + 10_000)

  afterAll(async () => {
    if (dev && dev.exitCode === null) {
      dev.kill('SIGTERM')
      await Promise.race([dev.exited, Bun.sleep(10_000)])
      if (dev.exitCode === null) dev.kill('SIGKILL')
    }
    cleanup()
  })

  test('acdev webs lists the one page of the app', async () => {
    const ran = await acdev(['webs'])
    expect(ran.code).toBe(0)
    expect(ran.out).toContain('hello-backend')
  })

  test('acdev eval answers from the page', async () => {
    const ran = await acdev(['eval', 'hello-backend', 'document.title'])
    expect(ran.code).toBe(0)
    expect(JSON.parse(ran.out.trim())).toBe('Hello Backend')
  })

  test('acdev console shows what the page logged', async () => {
    const ran = await until('the page output in acdev console', ['console'], (read) => read.code === 0 && read.out.includes('hello ready'))
    expect(ran.out).toContain('hello ready')
  })

  test('acdev devtools serves the page over CDP: /json/list names it and Runtime.evaluate answers from it', async () => {
    const ran = await acdev(['devtools', 'hello-backend'])
    expect(ran.code).toBe(0)
    const address = ran.out.split('\n').find((line) => line.startsWith('devtools://')) ?? ''
    const ws = new URL(address).searchParams.get('ws') ?? ''
    const port = Number(ws.split('/')[0]?.split(':')[1])
    expect(Number.isInteger(port)).toBe(true)
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { id: string; type: string; webSocketDebuggerUrl: string }[]
    const page = list.find((target) => target.id.startsWith('hello-backend'))
    expect(page?.type).toBe('page')
    const socket = new WebSocket(page!.webSocketDebuggerUrl)
    try {
      const title = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer to Runtime.evaluate within 10 s')), 10_000)
        socket.onerror = () => reject(new Error(`could not connect to ${page!.webSocketDebuggerUrl}`))
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }))
        socket.onmessage = (message) => {
          const answer = JSON.parse(String(message.data)) as { id?: number; result?: { result?: { value?: unknown } } }
          if (answer.id !== 1) return
          clearTimeout(timer)
          resolve(answer.result?.result?.value)
        }
      })
      expect(title).toBe('Hello Backend')
    } finally {
      socket.close()
    }
  })
})
