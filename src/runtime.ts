import { spawn as nodeSpawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { up } from './paths.ts'
import type { Env } from './sockets.ts'

export type { Env }

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Env
  readonly stdio?: StdioOptions
}

export interface Child {
  readonly process: ChildProcess
  readonly pid: number
  readonly exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
}

export class Runtime {
  static readonly bun = typeof process.versions['bun'] === 'string'
  static readonly CONDITIONS = ['node', 'import', 'module', 'default']

  static spawn(argv: readonly string[], options: SpawnOptions = {}): Child {
    const [file, ...args] = argv
    if (!file) throw new Error('nothing to run')
    const settings = {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: Runtime.#env(options.env ?? process.env),
      stdio: options.stdio ?? 'inherit',
    }
    const child =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
        ? nodeSpawn([file, ...args].map(Runtime.#quote).join(' '), { ...settings, shell: true })
        : nodeSpawn(file, args, settings)
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)))
    })
    exited.catch(() => undefined)
    return {
      process: child,
      pid: child.pid ?? 0,
      exited,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      },
    }
  }

  static #quote(arg: string): string {
    return /^[\w\-.:\\/=@+]+$/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  }

  static async readStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
    return Buffer.concat(chunks).toString('utf8')
  }

  static resolve(specifier: string, from: string): string {
    const [name, sub] = Runtime.#split(specifier)
    const dir = up(from, (at) => existsSync(join(at, 'node_modules', name, 'package.json')) && join(at, 'node_modules', name))
    if (!dir) throw new Error(`cannot find ${specifier} from ${from}`)
    return realpathSync(Runtime.#entry(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>, sub, specifier))
  }

  static #split(specifier: string): [string, string] {
    const parts = specifier.split('/')
    const count = specifier.startsWith('@') ? 2 : 1
    const name = parts.slice(0, count).join('/')
    const rest = parts.slice(count).join('/')
    return [name, rest ? `./${rest}` : '.']
  }

  static #entry(dir: string, pkg: Record<string, unknown>, sub: string, specifier: string): string {
    const exports = pkg['exports']
    if (exports !== undefined && exports !== null) {
      const map = typeof exports === 'string' || Array.isArray(exports) || !Object.keys(exports).some((key) => key.startsWith('.')) ? { '.': exports } : (exports as Record<string, unknown>)
      let target: unknown = map[sub]
      if (target === undefined) {
        for (const [key, value] of Object.entries(map)) {
          const star = key.indexOf('*')
          if (star >= 0 && sub.startsWith(key.slice(0, star)) && sub.endsWith(key.slice(star + 1))) {
            const middle = sub.slice(star, sub.length - (key.length - star - 1))
            target = JSON.parse(JSON.stringify(value).replaceAll('*', middle))
            break
          }
        }
      }
      const picked = Runtime.#condition(target)
      if (typeof picked !== 'string') throw new Error(`${specifier}: not exported for import by ${join(dir, 'package.json')}`)
      return join(dir, picked)
    }
    if (sub !== '.') return join(dir, sub)
    for (const field of ['module', 'main']) {
      const value = pkg[field]
      if (typeof value === 'string' && value) return Runtime.#file(join(dir, value))
    }
    return join(dir, 'index.js')
  }

  static #condition(target: unknown): string | null {
    if (typeof target === 'string') return target
    if (Array.isArray(target)) {
      for (const item of target) {
        const found = Runtime.#condition(item)
        if (found) return found
      }
      return null
    }
    if (target && typeof target === 'object') {
      for (const [key, value] of Object.entries(target)) {
        if (Runtime.CONDITIONS.includes(key)) {
          const found = Runtime.#condition(value)
          if (found) return found
        }
      }
    }
    return null
  }

  static #file(path: string): string {
    for (const candidate of [path, `${path}.js`, `${path}.mjs`, join(path, 'index.js')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    return path
  }

  static #env(env: Env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
    return out
  }
}

export class Jsonc {
  static parse(text: string): unknown {
    return JSON.parse(Jsonc.strip(text))
  }

  static strip(text: string): string {
    let out = ''
    let pending = ''
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!
      if (c === '"') {
        let end = i + 1
        while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
        out += pending + text.slice(i, end + 1)
        pending = ''
        i = end
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
        i--
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? text.length : end + 1
      } else if (c === ',') {
        out += pending
        pending = ','
      } else if (/\s/.test(c)) {
        if (pending) pending += c
        else out += c
      } else {
        out += (c === '}' || c === ']' ? pending.slice(1) : pending) + c
        pending = ''
      }
    }
    return out + pending
  }
}
