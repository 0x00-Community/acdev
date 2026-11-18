import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Acde } from '../../src/driver/index.ts'
import { cleanup, runtimeDir, skipping, tmp } from '../helpers.ts'

const CLI = join(import.meta.dir, '../../src/cli.ts')
const APP = join(import.meta.dir, '../fixtures/host/hello')
const RUNTIME = process.env['ACDEV_RUNTIME'] ?? ''
const WANTED = process.env['ACDEV_HOST_E2E'] === '1'
const START_MS = 120_000
const KEEP = process.env['ACDEV_HOST_KEEP'] === '1'

setDefaultTimeout(60_000)

const skip = skipping(!WANTED || !RUNTIME, 'host e2e: set ACDEV_HOST_E2E=1 and ACDEV_RUNTIME to a real acdev runtime (bun run test:host)')

interface Ran {
  readonly code: number
  readonly out: string
}

describe.skipIf(skip)('acdev dev --app on the host, driven through the CLI against the real runtime', () => {
  let project = ''
  let env: Record<string, string> = {}
  let home = ''
  let dev: ReturnType<typeof Bun.spawn> | null = null
  let driver: Acde | null = null

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
    home = tmp()
    project = join(home, 'hello')
    cpSync(APP, project, { recursive: true })
    const run = runtimeDir()
    env = {
      ...process.env as Record<string, string>,
      ACDEV_RUNTIME: RUNTIME,
      ACDEV_BROWSER: 'none',
      XDG_RUNTIME_DIR: run,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_CACHE_HOME: join(home, 'cache'),
    }
    dev = Bun.spawn([process.execPath, CLI, 'dev', project, '--app', 'hello-backend', '--headless', '--force'], {
      cwd: project, env, stdout: Bun.file(join(home, 'dev.out.log')), stderr: Bun.file(join(home, 'dev.err.log')),
    })
    await until('the page to show in acdev webs', ['webs'], (ran) => ran.code === 0 && ran.out.includes('hello-backend'))
    driver = await Acde.attach({ cwd: project, env })
  }, START_MS + 10_000)

  afterAll(async () => {
    await driver?.close()
    if (dev && dev.exitCode === null) {
      dev.kill('SIGTERM')
      await Promise.race([dev.exited, Bun.sleep(10_000)])
      if (dev.exitCode === null) dev.kill('SIGKILL')
    }
    if (KEEP) console.warn(`kept the scratch directory with dev.out.log and dev.err.log: ${home}`)
    else cleanup()
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

  const page = (code: string) => driver!.evaluate('hello-backend', code)
  const settle = async (code: string, wanted: unknown, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline && JSON.stringify(await page(code).catch(() => null)) !== JSON.stringify(wanted)) await Bun.sleep(200)
    return page(code)
  }
  const status = "document.querySelector('#status').textContent"
  const backendPid = () => page("fetch('/api/hello').then((r) => r.json()).then((a) => a.pid)") as Promise<number>
  const devLog = async (wanted: string) => {
    const read = () => Bun.file(join(home, 'dev.err.log')).text()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !(await read()).includes(wanted)) await Bun.sleep(300)
    return read()
  }

  test('the page reaches the app backend that the launcher started', async () => {
    expect(await settle(status, 'backend says hi', 30_000)).toBe('backend says hi')
    expect(await backendPid()).toBeGreaterThan(0)
  })

  test('a change to the backend reloads the app and starts the backend again', async () => {
    const before = await backendPid()
    const server = join(project, 'server.ts')
    writeFileSync(server, readFileSync(server, 'utf8').replace("hello: 'hi'", "hello: 'again'"))
    expect(await settle(status, 'backend says again', START_MS)).toBe('backend says again')
    expect(await backendPid()).not.toBe(before)
  }, START_MS + 10_000)

  test('a backend crash shows in the acdev dev log and the backend comes back', async () => {
    const before = await backendPid()
    await page("fetch('/api/crash').then(() => 'answered', () => 'failed')")
    await devLog('[hello-backend#backend] stopped (exit 3); starting it again')
    const log = await devLog('hello-backend crashes on purpose')
    expect(log).toContain('hello-backend crashes on purpose')
    expect(log).toContain('[hello-backend#backend] stopped (exit 3); starting it again')
    const deadline = Date.now() + 20_000
    let after = before
    while (Date.now() < deadline && after === before) {
      await Bun.sleep(300)
      after = await backendPid().catch(() => before)
    }
    expect(after).not.toBe(before)
  }, 60_000)

  test('snapshot sees the page, query finds the button, act clicks it', async () => {
    const snapshot = await driver!.snapshot()
    expect(snapshot.text).toContain('Hello Backend')
    expect(snapshot.windows.some((w) => w.app === 'hello-backend')).toBe(true)
    const found = await driver!.query({ selector: '#count' })
    expect(found.count).toBe(1)
    const clicked = await driver!.act(found.nodes[0]!.ref, 'click')
    expect(clicked.ok).toBe(true)
    expect(await settle("document.querySelector('#count').textContent", 'Clicked 1 times')).toBe('Clicked 1 times')
  })

  test('act types into the input; run does steps in order', async () => {
    const field = (await driver!.query({ selector: '#name' })).nodes[0]!
    expect((await driver!.act(field.ref, 'type', 'Ada')).ok).toBe(true)
    expect(await settle("document.querySelector('#name').value", 'Ada')).toBe('Ada')
    const button = (await driver!.query({ selector: '#count' })).nodes[0]!
    expect((await driver!.run([{ ref: button.ref, action: 'click' }, { ref: button.ref, action: 'click' }])).ok).toBe(true)
    expect(await settle("document.querySelector('#count').textContent", 'Clicked 3 times')).toBe('Clicked 3 times')
  })

  test('route answers the page fetch after a reload; network lists it; unroute takes it away', async () => {
    const id = await driver!.route('/api/hello', { json: { hello: 'routed' } })
    try {
      await driver!.reload('hello-backend')
      expect(await settle(status, 'backend says routed', 30_000)).toBe('backend says routed')
      const requests = await driver!.network({ web: 'hello-backend' })
      expect(requests.entries.some((r) => r.url.endsWith('/api/hello') && r.mocked === true)).toBe(true)
    } finally {
      expect(await driver!.unroute(id)).toEqual({ removed: 1, left: 0 })
    }
  }, START_MS)

  test('clock takes over the page time; emulate turns on dark mode', async () => {
    const state = await driver!.clock('hello-backend', { action: 'install', time: 0 })
    expect(state.installed).toBe(true)
    await driver!.emulate({ colorScheme: 'dark' })
    expect(await settle("matchMedia('(prefers-color-scheme: dark)').matches", true)).toBe(true)
    await driver!.emulate({ colorScheme: null })
  })

  test('screenshot of the page and of the screen; permissions has nothing waiting', async () => {
    const shot = await driver!.screenshot('hello-backend', { path: join(home, 'page.png') })
    expect(shot.width).toBeGreaterThan(0)
    expect(existsSync(join(home, 'page.png'))).toBe(true)
    const screen = await driver!.screen({ path: join(home, 'screen.png') })
    expect(screen.width).toBeGreaterThan(0)
    expect((await driver!.permissions()).pending).toEqual([])
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

  test('acdev mcp drives the same session', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: project, env, stderr: 'pipe' })
    const client = new Client({ name: 'acdev-host-test', version: '0.0.0' })
    await client.connect(transport)
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
        return { error: result.isError === true, text: result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') }
      }
      const webs = await call('webs')
      expect(webs.error).toBe(false)
      expect(webs.text).toContain('hello-backend')
      const evaluated = await call('eval', { code: 'document.title', target: 'hello-backend' })
      expect(evaluated.error).toBe(false)
      expect(evaluated.text).toContain('Hello Backend')
      const snapshot = await call('snapshot')
      expect(snapshot.text).toContain('Hello Backend')
    } finally {
      await client.close()
    }
  })

  test('acde:fs gives the declared documents place as a folder of the session, not the real Documents', async () => {
    const file = `acdev-host-${process.pid}-${Date.now()}.txt`
    const code = `(async () => {
      const { fs } = await import('acde:fs')
      const roots = await fs.roots()
      const documents = roots.find((root) => root.place === 'documents')
      await fs.writeFile(documents.id, '${file}', 'hello places')
      const text = (await fs.readText(documents.id, '${file}')).text
      return { text, private: roots.some((root) => root.source === 'private') }
    })()`
    const answer = (await page(code)) as { text: string; private: boolean }
    expect(answer.text).toBe('hello places')
    expect(answer.private).toBe(true)
    const sessions = readdirSync(tmpdir()).filter((name) => name.startsWith('acdev-places-'))
    const written = sessions.map((name) => join(tmpdir(), name, 'documents', file)).filter((path) => existsSync(path))
    expect(written.length).toBe(1)
    expect(existsSync(join(homedir(), 'Documents', file))).toBe(false)
  })

  test('act on a link to another page of the app answers, and the other page loads', async () => {
    const link = (await driver!.query({ selector: '#other' })).nodes[0]!
    const clicked = await driver!.act(link.ref, 'click')
    expect(clicked.ok).toBe(true)
    expect(await settle('document.title', 'Other Page')).toBe('Other Page')
    const back = (await driver!.query({ selector: '#back' })).nodes[0]!
    expect((await driver!.act(back.ref, 'click')).ok).toBe(true)
    expect(await settle('document.title', 'Hello Backend')).toBe('Hello Backend')
  })

  test('SIGTERM to acdev dev ends the runtime cleanly: the backend is stopped, and acdev dev exits 0', async () => {
    const backend = await backendPid()
    await driver?.close()
    driver = null
    dev!.kill('SIGTERM')
    await Promise.race([dev!.exited, Bun.sleep(15_000)])
    expect(dev!.exitCode).toBe(0)
    const gone = () => {
      try {
        process.kill(backend, 0)
        return false
      } catch {
        return true
      }
    }
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !gone()) await Bun.sleep(100)
    expect(gone()).toBe(true)
  })
})
