import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TraceStep } from '../driver/trace.ts'
import { Sessions } from '../sessions.ts'

export interface HostAction {
  readonly at: number
  readonly ms: number
  readonly ok: boolean
  readonly title: string
  readonly text: string
}

export interface Traced {
  readonly trace: { onStep: ((step: TraceStep) => void) | null }
}

const TEXT_MAX = 400

export function file(key: string, dir = `${Sessions.dir()}-timeline`): string {
  return join(dir, `${key.replace(/[^\w.-]/g, '_')}.jsonl`)
}

export function keyOf(session: { readonly pid: number; readonly endpoint: string }): string {
  return Sessions.isGuest(session as never) ? Sessions.VM : String(session.pid)
}

export function append(path: string, action: HostAction): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify({ ...action, text: action.text.slice(0, TEXT_MAX) })}\n`)
}

export function follow(acde: Traced, path: string): void {
  acde.trace.onStep = (step) => append(path, { at: step.at, ms: step.ms, ok: step.ok, title: step.title, text: step.text })
}

export function read(path: string): HostAction[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as HostAction] : []
    } catch {
      return []
    }
  })
}
