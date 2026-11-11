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
  readonly gone: Promise<number>
  kill(signal?: NodeJS.Signals): void
}

export interface Captured {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error: string | null
  readonly timedOut: boolean
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
    const status = (code: number | null, signal: NodeJS.Signals | null) =>
      code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0)
    const once = (event: 'close' | 'exit') => {
      const settled = new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once(event, (code, signal) => resolve(status(code, signal)))
      })
      settled.catch(() => undefined)
      return settled
    }
    const exited = once('close')
    return {
      process: child,
      pid: child.pid ?? 0,
      exited,
      gone: once('exit'),
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      },
    }
  }

  static async capture(argv: readonly string[], options: SpawnOptions & { readonly timeout: number }): Promise<Captured> {
    const child = Runtime.spawn(argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.process.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.process.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeout)
    try {
      const code = await child.exited
      return { code, stdout, stderr, error: null, timedOut }
    } catch (error) {
      return { code: null, stdout, stderr, error: error instanceof Error ? error.message : String(error), timedOut }
    } finally {
      clearTimeout(timer)
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
  static parse(text: string, file?: string): unknown {
    const json = Jsonc.strip(text)
    try {
      return JSON.parse(json)
    } catch (error) {
      if (file === undefined) throw error
      const at = Jsonc.errorAt(json)
      const before = text.slice(0, at).split('\n')
      const line = before.length
      const column = before.at(-1)!.length + 1
      const shown = text.split('\n')[line - 1]!.replace(/\r$/, '')
      const caret = `${' '.repeat(column - 1)}^`
      throw new Error(`${file}:${line}:${column}: not valid JSON (${(error as Error).message})\n  ${shown}\n  ${caret}`)
    }
  }

  static strip(text: string): string {
    let out = ''
    let pending = ''
    const put = (s: string) => {
      if (pending) pending += s
      else out += s
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!
      if (c === '"') {
        let end = i + 1
        while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
        out += pending + text.slice(i, end + 1)
        pending = ''
        i = end
      } else if (c === '/' && text[i + 1] === '/') {
        let end = i
        while (end < text.length && text[end] !== '\n') end++
        put(' '.repeat(end - i))
        i = end - 1
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2)
        const end = close < 0 ? text.length : close + 2
        put(text.slice(i, end).replace(/[^\n]/g, ' '))
        i = end - 1
      } else if (c === ',') {
        out += pending
        pending = ','
      } else if (/\s/.test(c)) {
        put(c)
      } else {
        out += (pending && (c === '}' || c === ']') ? ` ${pending.slice(1)}` : pending) + c
        pending = ''
      }
    }
    return out + pending
  }

  static errorAt(json: string): number {
    let i = 0
    const fail = (): never => {
      throw i
    }
    const space = () => {
      while (i < json.length && /\s/.test(json[i]!)) i++
    }
    const literal = (word: string) => {
      if (json.startsWith(word, i)) i += word.length
      else fail()
    }
    const string = () => {
      i++
      while (i < json.length && json[i] !== '"') {
        if (json[i]! < ' ') fail()
        i += json[i] === '\\' ? 2 : 1
      }
      if (i >= json.length) fail()
      i++
    }
    const value = (): void => {
      space()
      const c = json[i]
      if (c === '{') {
        i++
        space()
        if (json[i] === '}') return void i++
        for (;;) {
          space()
          if (json[i] !== '"') fail()
          string()
          space()
          if (json[i] !== ':') fail()
          i++
          value()
          space()
          if (json[i] === ',') i++
          else if (json[i] === '}') return void i++
          else fail()
        }
      }
      if (c === '[') {
        i++
        space()
        if (json[i] === ']') return void i++
        for (;;) {
          value()
          space()
          if (json[i] === ',') i++
          else if (json[i] === ']') return void i++
          else fail()
        }
      }
      if (c === '"') return string()
      if (c === 't') return literal('true')
      if (c === 'f') return literal('false')
      if (c === 'n') return literal('null')
      const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(json.slice(i))
      if (!number) fail()
      i += number![0].length
    }
    try {
      value()
      space()
      if (i < json.length) fail()
      return json.length
    } catch (at) {
      if (typeof at !== 'number') throw at
      return Math.min(at, json.length)
    }
  }
}
