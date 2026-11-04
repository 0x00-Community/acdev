import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const scratch: string[] = []

export function tmp(): string {
  const dir = mkdtempSync('/tmp/acde-test-')
  scratch.push(dir)
  return dir
}

export function cleanup(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(PORT|BUN_PORT|NODE_PORT|ACDERT|ACDE_API|ACDE_APP_ID|ACDE_APP_SOCKETS|XDG_RUNTIME_DIR)$/.test(key)) out[key] = value
  }
  return { ...out, ...extra }
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
      if (done) throw new Error(`no "${prefix}" line; stdout: ${text}; stderr: ${await new Response(child.stderr).text()}`)
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
