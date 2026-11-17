import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Devd } from './devd.ts'

export const BIN = '/opt/acdev/bin'
const SKIPPED = new Set(['target', '.git', 'node_modules'])
const POLL = 1000

export interface Executable {
  readonly name: string
  readonly path: string
}

export interface LoopOptions {
  readonly dir: string
  readonly bins: readonly string[]
  readonly run: string | null
}

interface CargoMessage {
  readonly reason?: string
  readonly target?: { readonly name?: string; readonly kind?: readonly string[] }
  readonly executable?: string | null
}

export function executables(lines: readonly string[], bins: readonly string[]): Executable[] {
  const found = new Map<string, string>()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    const message = JSON.parse(line) as CargoMessage
    const name = message.target?.name
    if (message.reason !== 'compiler-artifact' || !message.executable || !name) continue
    if (message.target?.kind?.includes('bin') && (bins.length === 0 || bins.includes(name))) found.set(name, message.executable)
  }
  const missing = bins.filter((bin) => !found.has(bin))
  if (missing.length) throw new Error(`vm dev: cargo built no binary ${missing.join(', ')}`)
  return [...found].map(([name, path]) => ({ name, path }))
}

export function snapshot(dir: string): string {
  const parts: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const stat = statSync(path)
        parts.push(`${path}:${stat.mtimeMs}:${stat.size}`)
      }
    }
  }
  walk(dir)
  return parts.sort().join('\n')
}

export function startCommand(options: LoopOptions, built: readonly Executable[]): string {
  return `export PATH=${BIN}:$PATH; ${options.run ?? built[0]!.name}`
}

function cargo(dir: string, bins: readonly string[]): Promise<Executable[]> {
  const args = ['build', '--release', '--message-format', 'json-render-diagnostics', '--manifest-path', join(dir, 'Cargo.toml'),
    ...bins.flatMap((bin) => ['--bin', bin])]
  const child = spawn('cargo', args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
  const lines: string[] = []
  createInterface({ input: child.stdout! }).on('line', (line) => lines.push(line))
  return new Promise((done, failed) => {
    child.on('error', failed)
    child.on('close', (code) => {
      if (code === 0) done(executables(lines, bins))
      else failed(new Error(`vm dev: cargo build exited ${code}`))
    })
  })
}

export class DevLoop {
  #pid: number | null = null
  readonly dir: string

  constructor(readonly devd: Devd, readonly options: LoopOptions, readonly say: (line: string) => void) {
    this.dir = resolve(options.dir)
  }

  async cycle(stopped?: AbortSignal): Promise<void> {
    let built: Executable[]
    try {
      built = await cargo(this.dir, this.options.bins)
    } catch (error) {
      this.say(`${(error as Error).message}; ${this.#pid === null ? 'nothing runs' : `process group ${this.#pid} keeps running`}`)
      return
    }
    if (stopped?.aborted) return
    await this.stop()
    const files = built.flatMap((exe) => Devd.files(exe.path, `${BIN}/${exe.name}`))
    await this.devd.push(files)
    const { pid, log } = await this.devd.detach(['/bin/sh', '-c', startCommand(this.options, built)])
    this.#pid = pid
    this.say(`pushed ${built.map((exe) => exe.name).join(', ')} to guest:${BIN}; running as process group ${pid} (guest:${log})`)
    void this.devd.run(['/bin/sh', '-c', `exec tail -n +1 -F --pid=${pid} ${log} 2>/dev/null`], {
      stdout: (chunk) => process.stdout.write(chunk),
    }).catch(() => undefined)
  }

  async stop(): Promise<void> {
    if (this.#pid === null) return
    const pid = this.#pid
    this.#pid = null
    await this.devd.kill(pid).then(() => this.say(`stopped process group ${pid}`), () => undefined)
  }

  async watch(stopped: AbortSignal): Promise<void> {
    let seen = snapshot(this.dir)
    await this.cycle(stopped)
    while (!stopped.aborted) {
      await new Promise((tick) => setTimeout(tick, POLL))
      const now = snapshot(this.dir)
      if (now === seen || stopped.aborted) continue
      seen = now
      this.say('the source changed: building again')
      await this.cycle(stopped)
    }
    await this.stop()
  }
}
