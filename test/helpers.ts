import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { Runtime, type Child } from '../src/runtime.ts'

export const WINDOWS = process.platform === 'win32'

export function skipping(skip: boolean, why: string): boolean {
  if (skip) console.warn(`skipped: ${why}`)
  return skip
}

const scratch: string[] = []
const running = new Set<Child>()

export function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acde-test-'))
  scratch.push(dir)
  return dir
}

export interface SdkMirror {
  readonly dist: string
  readonly version: string
  stop(): void
}

export function sdkMirror(api = join(import.meta.dir, '../../acdert/web/packages/acde-api/dist')): SdkMirror {
  const { version } = JSON.parse(readFileSync(join(api, 'package.json'), 'utf8')) as { version: string }
  const root = tmp()
  const stage = join(root, 'stage', 'package')
  cpSync(api, stage, { recursive: true, filter: (from) => !/[\\/]node_modules$/.test(from) })
  mkdirSync(join(root, version), { recursive: true })
  const windows = process.platform === 'win32'
  const tar = windows ? join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar'
  const tarball = join(root, version, `acde-api-${version}.tar.gz`)
  const plain = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []
  const packed = Bun.spawnSync([tar, ...plain, '-czf', tarball, '-C', join(root, 'stage'), 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (packed.exitCode !== 0) throw new Error(`tar: ${packed.stderr.toString()}`)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const file = join(root, decodeURIComponent(new URL(request.url).pathname))
      return existsSync(file) ? new Response(Bun.file(file)) : new Response('not found', { status: 404 })
    },
  })
  return { dist: `http://127.0.0.1:${server.port}`, version, stop: () => void server.stop(true) }
}

export function cleanup(): void {
  for (const child of running) child.kill('SIGKILL')
  running.clear()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
}

const SCRUBBED =
  /^(PORT|BUN_PORT|NODE_PORT|ACDERT|ACDERT_DIST|ACDE_INSTALL|ACDE_APP_(ID|SOCKETS|CHANNEL|CONTROL)|XDG_RUNTIME_DIR)$/

export function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED.test(key)) out[key] = value
  }
  const shown = out['WAYLAND_DISPLAY'] || out['DISPLAY']
  const display: Record<string, string> = shown ? {} : { WAYLAND_DISPLAY: 'acde-test' }
  return { ...display, ...out, ...extra }
}

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly out: string
}

export async function collect(
  argv: readonly string[],
  options: { readonly cwd?: string; readonly env: Record<string, string> },
): Promise<Ran> {
  const child = Runtime.spawn(argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  running.add(child)
  let stdout = ''
  let stderr = ''
  let out = ''
  child.process.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
    out += chunk
  })
  child.process.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
    out += chunk
  })
  try {
    return { code: await child.exited, stdout, stderr, out }
  } finally {
    running.delete(child)
  }
}

export async function line(child: Subprocess<'ignore', 'pipe', 'pipe'>, prefix: string, ms = 10_000): Promise<string> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => child.kill(), ms)
  try {
    for (;;) {
      const found = text.split('\n').find((l) => l.startsWith(prefix))
      if (found !== undefined) return found
      const { done, value } = await reader.read()
      if (done) {
        throw new Error(`no "${prefix}" line; stdout: ${text}; stderr: ${await new Response(child.stderr).text()}`)
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

export async function get(socket: string, path = '/p'): Promise<string> {
  const answer = await fetch(`http://acde${path}`, { unix: socket })
  return answer.text()
}

export function inetSockets(pid: number): string[] | null {
  if (Bun.which('lsof')) {
    const all = Bun.spawnSync(['lsof', '-nP', '-a', '-p', String(pid)]).stdout.toString()
    if (!/\bunix\b/.test(all)) return null
    const inet = Bun.spawnSync(['lsof', '-nP', '-a', '-p', String(pid), '-i']).stdout.toString()
    return inet.split('\n').slice(1).filter(Boolean)
  }
  if (existsSync(`/proc/${pid}/fd`)) {
    const mine = new Set<string>()
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))
        if (m) mine.add(m[1]!)
      } catch {}
    }
    const found: string[] = []
    for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
      const file = join(`/proc/${pid}/net`, table)
      if (!existsSync(file)) continue
      for (const row of readFileSync(file, 'utf8').split('\n').slice(1)) {
        const inode = row.trim().split(/\s+/)[9]
        if (inode && mine.has(inode)) found.push(`${table} ${row.trim()}`)
      }
    }
    return found
  }
  return null
}

const FAKE_ACDERT = join(import.meta.dir, 'fixtures/dev/fake-acdert.ts')

export function fakeAcdert(root: string): string {
  const acdert = join(root, WINDOWS ? 'acdert.cmd' : 'acdert')
  const script = WINDOWS
    ? `@echo off\r\n"${process.execPath}" "${FAKE_ACDERT}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACDERT)} "$@"\n`
  writeFileSync(acdert, script, { mode: 0o755 })
  return acdert
}

const FAKE_BROWSER = join(import.meta.dir, 'fixtures/dev/fake-browser.ts')

export function fakeBrowser(root: string): string {
  const browser = join(root, WINDOWS ? 'browser.cmd' : 'browser')
  const script = WINDOWS
    ? `@echo off\r\n"${process.execPath}" "${FAKE_BROWSER}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_BROWSER)} "$@"\n`
  writeFileSync(browser, script, { mode: 0o755 })
  return browser
}

export function standIn(): { root: string; env: Record<string, string>; project: string } {
  const root = tmp()
  const log = join(root, 'fake.log')
  const acdert = fakeAcdert(root)
  writeFileSync(log, '')
  const project = join(root, 'alpha')
  mkdirSync(project)
  writeFileSync(join(project, 'acde.config.jsonc'), JSON.stringify({ type: 'app', id: 'alpha' }))
  writeFileSync(join(project, 'index.html'), '<!doctype html><title>Alpha</title><p>alpha</p>')
  const vars = env({ TMPDIR: root, XDG_RUNTIME_DIR: root, ACDERT: acdert, FAKE_ACDERT_LOG: log })
  return { root, project: realpathSync(project), env: vars }
}
