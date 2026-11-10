import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Acde } from '../src/driver/index.ts'
import { cleanup, standIn } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')

afterAll(cleanup)

type Block = { type: string; text?: string; data?: string; mimeType?: string }

async function connect(cwd: string, env: Record<string, string>, args: string[] = []) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', ...args], cwd, env, stderr: 'pipe' })
  const client = new Client({ name: 'acde-test', version: '0.0.0' })
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Block[]; isError?: boolean }
    return { error: result.isError === true, text: result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), content: result.content }
  }
  return { client, call }
}

describe('acde mcp', () => {
  test('lists its tools; start runs acde dev here; the tools drive it; logs; stop', async () => {
    const s = standIn()
    const { client, call } = await connect(s.project, s.env)
    try {
      const tools = (await client.listTools()).tools
      expect(tools.map((t) => t.name).sort()).toEqual(['act', 'answer', 'choose_files', 'choose_folder', 'choose_save_file', 'clipboard', 'console', 'emulate', 'eval', 'logs', 'network', 'open', 'permissions', 'query', 'revoke', 'route', 'run', 'screenshot', 'sessions', 'snapshot', 'start', 'stop', 'unroute', 'wait_for', 'webs'])
      expect(tools.find((t) => t.name === 'answer')!.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true })
      expect(tools.find((t) => t.name === 'snapshot')!.annotations?.readOnlyHint).toBe(true)

      const none = await call('webs')
      expect(none.error).toBe(true)
      expect(none.text).toContain('no acde dev is running')
      expect((await call('logs')).error).toBe(true)

      const started = await call('start')
      expect(started.error).toBe(false)
      expect(started.text).toMatch(/^acde dev \d+ runs app alpha \(/)
      expect(started.text).toContain('alpha#7  app      alpha  7       Alpha')
      expect((await call('start')).text).toContain('stop it first')
      expect((await call('sessions')).text).toMatch(/^\* \d+  app alpha  .*\[started here\]/)

      expect((await call('snapshot', { find: 'Add', all: true })).text).toBe('snapshot {"window":null,"find":"Add","all":true}')
      expect((await call('act', { ref: 'w1.2', action: 'settext', arg: 'Buy milk' })).text).toBe('settext w1.2 "Buy milk"')
      const invalid = await call('act', { ref: 'w1.2', action: 'explode' })
      expect(invalid.error).toBe(true)
      expect(invalid.text).toContain('action')
      const ran = await call('run', { steps: [{ ref: 'w1.3', action: 'click' }] })
      expect(ran.error).toBe(false)
      expect(ran.text).toBe('click w1.3 null')

      const waited = await call('wait_for', { text: 'Buy milk', timeout_ms: 3000 })
      expect(waited.error).toBe(false)
      expect((await call('wait_for', { text: 'Nothing like this', timeout_ms: 200 })).text).toStartWith('waited 200 ms: "Nothing like this" did not appear')
      expect((await call('wait_for', { text: 'Nothing like this', gone: true })).text).toBe('"Nothing like this" is gone')

      const opened = await call('open', { app: 'beta' })
      expect(opened.text).toStartWith('opened beta: w2 "Beta"')
      expect((await call('open', { app: 'nope' })).error).toBe(true)

      const shot = await call('screenshot', { path: 'shot.png' })
      expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
      expect(shot.text).toBe(`beta#8: 3x3, written to ${join(s.project, 'shot.png')}`)
      expect(readFileSync(join(s.project, 'shot.png')).subarray(1, 4).toString()).toBe('PNG')
      expect((await call('screenshot', { target: 'w1' })).text).toStartWith('alpha#7: 8x6')

      expect(JSON.parse((await call('eval', { code: 'document.title' })).text)).toEqual({ web: 'beta#8', code: 'document.title' })

      const screen = await call('screenshot', { target: 'screen' })
      expect(screen.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
      expect(screen.text).toBe('screen: 1x1')
      expect((await call('query', { selector: '[data-testid="add"]', window: 'w1' })).text).toBe('1 in w1:\n- button "Add" [disabled] [w1.3] <button>')
      expect((await call('query', { selector: '.ghost', window: 'w1' })).text).toBe('1 in w1:\n- generic [w1.99] <div> [hidden]')
      expect((await call('query', { selector: 'nav', window: 'w1' })).text).toBe('nothing in w1 matches "nav"')
      expect((await call('console')).text).toBe('next: 3\n   1 log    alpha#7  alpha ready\n   2 info   alpha#7  added Buy milk')
      expect((await call('console', { since: 3 })).text).toBe('next: 3\n(nothing)')
      expect((await call('network', { web: 'alpha' })).text).toBe('next: 2\n   1 POST   201 http://acde.local/api/tasks  (fetch 2 B 3 ms) alpha#7')
      expect((await call('choose_folder', { path: 'pick' })).text).toBe(`the next folder chooser will answer ${join(s.project, 'pick')}`)
      expect((await call('choose_folder', { cancel: true })).text).toBe('the next folder chooser will be cancelled')
      expect((await call('choose_folder', {})).error).toBe(true)
      expect((await call('choose_files', { paths: ['a.txt', 'b.txt'] })).text).toBe(`the next file chooser will answer ${join(s.project, 'a.txt')}, ${join(s.project, 'b.txt')}`)
      expect((await call('choose_files', { cancel: true })).text).toBe('the next file chooser will be cancelled')
      expect((await call('choose_files', {})).error).toBe(true)
      expect((await call('choose_save_file', { path: 'out.txt' })).text).toBe(`the next save chooser will answer ${join(s.project, 'out.txt')}`)
      expect((await call('choose_save_file', { cancel: true })).text).toBe('the next save chooser will be cancelled')
      expect((await call('choose_save_file', {})).error).toBe(true)
      expect((await call('route', { url: '/api/tasks', status: 503, times: 2 })).text).toBe('route 1: any method /api/tasks → 503, 2 times')
      expect((await call('route', { url: 'tasks$', regex: true, method: 'POST', abort: 'offline' })).text).toBe('route 2: POST /tasks$/ → fails (offline)')
      expect((await call('route', { url: '/x', json: { a: 1 } })).text).toBe('route 3: any method /x → 200')
      expect((await call('unroute', { id: 2 })).text).toBe('removed 1 route, 2 left')
      expect((await call('unroute', {})).text).toBe('removed 2 routes, 0 left')
      const guarded = await call('clipboard', { text: 'hi' })
      expect(guarded.error).toBe(true)
      expect(guarded.text).toContain("has a window on screen, so its clipboard is the user's system clipboard")
      expect((await call('clipboard', { text: 'hi', system: true })).text).toBe('"hi"')
      expect((await call('clipboard', { system: true })).text).toBe('"hi"')
      expect(tools.find((t) => t.name === 'clipboard')!.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true })
      expect((await call('act', { ref: 'w1.6', action: 'select', arg: ['high'] })).text).toContain('selected ["high"]')
      expect((await call('emulate', { colorScheme: 'dark' })).text).toBe('colour scheme dark (emulated), reduced motion off')
      expect((await call('emulate', { colorScheme: 'system', reducedMotion: 'reduce' })).text).toBe('colour scheme light, reduced motion on')
      expect(JSON.parse((await call('eval', { code: '1', target: 'desktop' })).text)).toEqual({ web: 'desktop', code: '1' })

      const logs = await call('logs', { grep: 'fake acdert' })
      expect(logs.text).toMatch(/^next: \d+\n\[alpha#7\] js: fake acdert is up$/)
      const next = Number(/^next: (\d+)/.exec(logs.text)![1])
      expect((await call('logs', { since: next })).text).toBe(`next: ${next}\n(no lines)`)

      const stopped = await call('stop')
      expect(stopped.text).toMatch(/^stopped acde dev \d+$/)
      expect((await call('webs')).error).toBe(true)
    } finally {
      await client.close()
    }
  }, 60_000)

  test('attaches to an acde dev running elsewhere, and stops what it started when the client goes', async () => {
    const s = standIn()
    const outside = await Acde.launch({ cwd: s.project, env: s.env })
    try {
      const { client, call } = await connect(s.root, s.env, ['--session', String(outside.session.pid)])
      expect((await call('webs')).text).toContain('alpha#7')
      const logs = await call('logs')
      expect(logs.error).toBe(true)
      expect(logs.text).toContain('started elsewhere')
      await client.close()
    } finally {
      await outside.close()
    }

    const { client, call } = await connect(s.project, s.env)
    const started = await call('start', { headless: true })
    const pid = Number(/^acde dev (\d+)/.exec(started.text)![1])
    expect((await call('clipboard', { text: 'isolated' })).text).toBe('"isolated"')
    await client.close()
    const sessions = join(s.root, 'acde-dev')
    for (let i = 0; i < 100 && existsSync(join(sessions, `${pid}.json`)); i++) await Bun.sleep(50)
    expect(existsSync(join(sessions, `${pid}.json`))).toBe(false)
  }, 60_000)

  test('act close on the only window of a single-app session succeeds and says the session ended; ' +
    'the next call says it stopped; another action that loses the connection is an error', async () => {
    const s = standIn()
    const started = await connect(s.project, s.env)
    try {
      const pid = Number(/^acde dev (\d+)/.exec((await started.call('start', { headless: true })).text)![1])
      const closed = await started.call('act', { ref: 'w1', action: 'close' })
      expect([closed.error, closed.text])
        .toEqual([false, `closed w1; acdert exited with it, so acde dev ${pid} ended`])
      const next = await started.call('webs')
      expect(next.error).toBe(true)
      expect(next.text).toStartWith(`the acde dev started here (pid ${pid}) stopped; last output:\n`)
    } finally {
      await started.client.close()
    }

    const outside = await Acde.launch({ cwd: s.project, env: s.env })
    const attached = await connect(s.project, s.env)
    try {
      const pid = outside.session.pid
      const closed = await attached.call('act', { ref: 'w1', action: 'close' })
      expect([closed.error, closed.text])
        .toEqual([false, `closed w1; acdert exited with it, so acde dev ${pid} ended`])
      const next = await attached.call('snapshot')
      expect(next.error).toBe(true)
      expect(next.text).toStartWith(`acde dev ${pid} stopped; no acde dev is running (`)
      expect((await attached.call('snapshot')).text).toStartWith('no acde dev is running (')
    } finally {
      await attached.client.close()
      await outside.close()
    }

    const crashing = await connect(s.project, { ...s.env, FAKE_ACDERT_DIES_ON: 'click' })
    try {
      const pid = Number(/^acde dev (\d+)/.exec((await crashing.call('start', { headless: true })).text)![1])
      const lost = await crashing.call('act', { ref: 'w1.3', action: 'click' })
      expect([lost.error, lost.text]).toEqual([true, 'acdert closed the connection'])
      expect((await crashing.call('webs')).text).toStartWith(`the acde dev started here (pid ${pid}) stopped;`)
    } finally {
      await crashing.client.close()
    }
  }, 60_000)

  test('approval prompts: start says what an app waits for; permissions, answer and revoke', async () => {
    const s = standIn()
    const { client, call } = await connect(s.project, { ...s.env, FAKE_ACDERT_WAITS: '1' })
    try {
      const started = await call('start', { headless: true })
      expect(started.error).toBe(false)
      const hints = 'alpha waits for approval of launch: the answer tool allows or denies it\n' +
        'beta waits for approval of fs.documents: the answer tool allows or denies it'
      expect(started.text).toEndWith(`\n\nNAME  KIND  APP  WINDOW  TITLE\n${hints}`)
      expect((await call('webs')).text).toBe(`NAME  KIND  APP  WINDOW  TITLE\n${hints}`)
      const waiting = '  1  alpha  launch  (launch)\n  2  beta  fs.documents  (request)'
      expect((await call('permissions')).text).toBe(`pending:\n${waiting}\ndecisions: none`)
      const several = await call('answer', { allow: false })
      expect([several.error, several.text])
        .toEqual([true, `2 approval prompts wait; name one with prompt, or with app and capability:\n${waiting}`])
      expect((await call('answer', { allow: true, prompt: 1, app: 'alpha' })).text)
        .toBe('answer: give prompt, or app and capability, not both')
      expect((await call('answer', { allow: false, app: 'alpha' })).text)
        .toBe('an approval prompt is named by its id, or by its app and its capability together')
      const unnamed = 'answer: to allow, name the app and the capability (permissions lists what waits)'
      for (const args of [{}, { prompt: 1 }, { app: 'alpha' }]) {
        const refused = await call('answer', { allow: true, ...args })
        expect([refused.error, refused.text]).toEqual([true, unnamed])
      }
      expect((await call('permissions')).text).toBe(`pending:\n${waiting}\ndecisions: none`)
      expect((await call('answer', { allow: true, app: 'alpha', capability: 'launch' })).text)
        .toBe('allowed alpha launch (prompt 1)')
      expect((await call('webs')).text).toContain('alpha#7  app      alpha  7       Alpha')
      expect((await call('answer', { allow: false })).text).toBe('denied beta fs.documents (prompt 2)')
      const none = await call('answer', { allow: true, app: 'beta', capability: 'fs.documents' })
      expect([none.error, none.text]).toEqual([true,
        'no approval prompt of beta for fs.documents is waiting: it is already denied (revoke takes that back)'])
      expect((await call('permissions')).text)
        .toBe('pending: none\ndecisions:\n  alpha  launch  granted\n  beta  fs.documents  denied')
      expect((await call('revoke', { app: 'alpha', capability: 'launch' })).text).toBe('revoked alpha launch')
      const again = await call('revoke', { app: 'alpha', capability: 'launch' })
      expect([again.error, again.text])
        .toEqual([true, 'no decision about alpha launch to revoke (permissions lists the decisions)'])
    } finally {
      await client.close()
    }
  }, 60_000)
})
