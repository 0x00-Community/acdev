import { format } from 'node:util'
import { Color, type Palette } from './color.ts'

export interface Sink {
  readonly isTTY?: boolean
  write(text: string): unknown
}

export const Exit = { DONE: 0, ERROR: 1, NOTHING: 2, DECLINED: 3 } as const

export class Output {
  static readonly LABELS: Readonly<Record<string, keyof Palette>> = {
    'error:': 'error', 'warning:': 'warn', 'note:': 'dim', 'hint:': 'dim', 'ok:': 'ok',
  }

  static debug(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env['ACDE_DEBUG']
    return value !== undefined && value !== '' && value !== '0'
  }

  static palette(stream: Sink, env: NodeJS.ProcessEnv = process.env): Palette {
    return Color.palette(Color.enabled(stream, env))
  }

  static labelled(line: string, c: Palette): string {
    if (!c.on || line.includes('\x1b[')) return line
    const [, prefix = '', label = '', rest = ''] = /^(acde: )?(\S+:)(.*)$/s.exec(line) ?? []
    const paint = Output.LABELS[label]
    if (!paint) return line
    return `${prefix}${(c[paint] as (text: string) => string)(label)}${rest}`
  }

  static line(text: string, stream: Sink = process.stderr, env: NodeJS.ProcessEnv = process.env): void {
    const c = Output.palette(stream, env)
    stream.write(`${text.split('\n').map((line) => Output.labelled(line, c)).join('\n')}\n`)
  }

  static install(stream: Sink = process.stderr): void {
    const write = (...args: unknown[]) => Output.line(format(...args), stream)
    console.error = write
    console.warn = write
  }

  static option(command: string, option: string, value: string, expected: string): Error {
    return new Error(`${command}: --${option} ${value}: ${expected} (acde ${command} --help)`)
  }

  static message(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    return text.replace(/^(?:Error: )+/, '')
  }

  static fail(error: unknown, stream: Sink = process.stderr, env: NodeJS.ProcessEnv = process.env): void {
    const c = Output.palette(stream, env)
    stream.write(`${c.error('acde:')} ${Output.message(error)}\n`)
    if (Output.debug(env) && error instanceof Error && error.stack) stream.write(`${error.stack}\n`)
  }
}
