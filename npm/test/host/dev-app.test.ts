import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Acde } from '../../src/driver/index.ts'
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
    const runtimeDir = join(home, 'run')
    mkdirSync(runtimeDir, { mode: 0o700 })
    env = {
      ...process.env as Record<string, string>,
      ACDEV_RUNTIME: RUNTIME,
      XDG_RUNTIME_DIR: runtimeDir,
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

  const page = (code: string) => driver!.evaluate('hello-backend', code)
  const settle = async (code: string, wanted: unknown) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && JSON.stringify(await page(code)) !== JSON.stringify(wanted)) await Bun.sleep(200)
    return page(code)
  }

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
    await driver!.reload('hello-backend')
    expect(await settle("document.querySelector('#status').textContent", 'backend says routed')).toBe('backend says routed')
    const requests = await driver!.network({ web: 'hello-backend' })
    expect(requests.entries.some((r) => r.url.endsWith('/api/hello'))).toBe(true)
    expect(await driver!.unroute(id)).toEqual({ removed: 1, left: 0 })
  })

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
})
