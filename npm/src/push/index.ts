import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import type { Built } from '../package.ts'
import { Devd, type PushFile } from '../vm/devd.ts'

export const OVERLAY = '/var/lib/acdev/overlay'
export const AGENT = '/usr/bin/acdev-agent'
export const RECORD = 'push.json'

export type Stamps = Readonly<Record<string, readonly [number, number]>>

export interface PushRecord {
  readonly commit: string | null
  readonly dirty: boolean
  readonly at: string
  readonly files: Stamps
}

export interface Guest {
  run(argv: readonly string[], out?: (text: string) => void): Promise<number>
  push(files: readonly PushFile[]): Promise<number>
}

export function stamps(dir: string): Stamps {
  const out: Record<string, readonly [number, number]> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const { size, mtimeMs } = statSync(path)
        out[relative(dir, path).split(sep).join('/')] = [size, Math.round(mtimeMs)]
      }
    }
  }
  walk(dir)
  delete out[RECORD]
  return out
}

export function changed(now: Stamps, before: Stamps): { send: string[]; gone: string[] } {
  const same = (a: readonly number[] | undefined, b: readonly number[]) => !!a && a[0] === b[0] && a[1] === b[1]
  return {
    send: Object.keys(now).filter((path) => !same(before[path], now[path]!)),
    gone: Object.keys(before).filter((path) => !(path in now)),
  }
}

export function backend(paths: readonly string[]): string[] {
  return paths.filter((path) => /^(backend|services)\//.test(path) || /^apps\/[^/]+\/backend\//.test(path))
}

export function reloads(built: Built): string[] {
  return [...built.apps.flatMap((app) => ['--reload', app]), ...(built.desktops.length ? ['--desktop'] : [])]
}

function git(dir: string, args: readonly string[]): string | null {
  const ran = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  return ran.status === 0 ? ran.stdout.trim() : null
}

export function record(source: string, files: Stamps, at = new Date()): PushRecord {
  const commit = git(source, ['rev-parse', 'HEAD'])
  return { commit, dirty: commit !== null && !!git(source, ['status', '--porcelain']), at: at.toISOString(), files }
}

async function before(guest: Guest, remote: string): Promise<Stamps> {
  const chunks: string[] = []
  if (await guest.run(['/bin/cat', posix.join(remote, RECORD)], (chunk) => chunks.push(chunk)) !== 0) return {}
  const text = chunks.join('')
  try {
    return (JSON.parse(text) as Partial<PushRecord>).files ?? {}
  } catch {
    return {}
  }
}

export async function reset(guest: Guest, name: string | null, say: (line: string) => void): Promise<number> {
  const code = await guest.run([AGENT, 'overlay', 'reset', ...(name ? [name] : [])], say)
  if (code === 0) say(`push: the pushed files of ${name ?? 'every package'} are gone; the installed package shows again`)
  return code
}

export async function push(guest: Guest, built: Built, source: string, say: (line: string) => void): Promise<number> {
  const remote = posix.join(OVERLAY, built.id)
  const now = stamps(built.dir)
  const { send, gone } = changed(now, await before(guest, remote))
  const all = Devd.files(built.dir, remote)
  const sent = all.filter((file) => send.includes(posix.relative(remote, file.path)))
  const kept = Buffer.from(`${JSON.stringify(record(resolve(source), now), null, 2)}\n`)
  if (gone.length) await guest.run(['/bin/rm', '-f', '--', ...gone.map((path) => posix.join(remote, path))])
  await guest.push([...sent, { path: posix.join(remote, RECORD), mode: 0o644, data: kept }])
  say(`push: ${sent.length} changed file(s) of ${built.id} sent, ${gone.length} removed`)
  const code = await guest.run([AGENT, 'overlay', 'mount', built.id, ...reloads(built)], say)
  if (code !== 0) return code
  const moved = backend(send)
  if (!moved.length) return 0
  const named = `${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ', …' : ''}`
  say(`push: the backend changed (${named}): its pages reloaded, restart the session to run it`)
  return 0
}

export async function run(args: readonly string[], flags: ReadonlyMap<string, string>): Promise<number> {
  if (flags.get('session') !== 'vm') {
    throw new Error('push: it pushes into the guest only: acdev push [dir] --session vm (acdev dev reloads a host session by itself)')
  }
  const { Machine } = await import('../vm/machine.ts')
  const machine = new Machine()
  machine.running()
  const devd = machine.devd()
  const guest: Guest = {
    run: (argv, out) => devd.run(argv, out ? { stdout: (chunk) => out(chunk.toString()), stderr: (chunk) => out(chunk.toString()) } : {}),
    push: (files) => devd.push(files),
  }
  const say = (line: string) => console.error(`acdev ${line.trimEnd()}`)
  if (flags.has('reset')) return reset(guest, null, say)
  const { AppPackage } = await import('../package.ts')
  const pkg = new AppPackage(args[0] ?? '.')
  return push(guest, await pkg.build(resolve(pkg.dir, '.acde'), { command: 'build' }), pkg.dir, say)
}
