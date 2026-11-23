import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DevClient, type Message } from '../../src/ipc.ts'
import type { Session } from '../../src/sessions.ts'
import { env, fakeAcdert, tmp, WINDOWS } from '../helpers.ts'

const CLI = join(import.meta.dir, '../../src/cli.ts')

export function project(dir: string, config: object, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify(config))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return realpathSync(dir)
}

export function start(args: string[], cwd: string, extra: Record<string, string> = {}, root = tmp()) {
  const log = join(root, existsSync(join(root, 'fake.log')) ? `fake-${randomUUID()}.log` : 'fake.log')
  const acdert = fakeAcdert(root)
  writeFileSync(log, '')
  const vars = {
    TMPDIR: root, XDG_RUNTIME_DIR: root, ACDEV_RUNTIME: acdert, FAKE_ACDERT_LOG: log, ACDE_PATH: '/inherited', ...extra,
  }
  const child = Bun.spawn([process.execPath, CLI, 'dev', ...args], {
    cwd, env: env(vars), stdout: 'pipe', stderr: 'pipe',
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([o, e]) => o + e)
  const entries = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv?: string[]; path?: string; got?: Message })
  const tool = async (argv: string[], from = cwd, stdin?: string, more: Record<string, string> = {}) => {
    const run = Bun.spawn([process.execPath, CLI, ...argv], {
      cwd: from,
      env: env({ TMPDIR: root, XDG_RUNTIME_DIR: root, ...more }),
      stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      run.exited, new Response(run.stdout).text(), new Response(run.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  const sessions = join(root, 'acde-dev')
  const file = join(sessions, `${child.pid}.json`)
  const stop = async () => {
    if (!WINDOWS || !existsSync(file)) child.kill('SIGTERM')
    else {
      const session = JSON.parse(readFileSync(file, 'utf8')) as Session
      const link = await DevClient.connect(session.endpoint)
      link.send({ type: 'quit' })
      link.close()
    }
    return child.exited
  }
  return { child, output, entries, tool, root, sessions, file, stop }
}
