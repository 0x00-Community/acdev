import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as Evidence from '../evidence/index.ts'

export const KEEP_RUNS = 20
const RUN = /^\d{8}T\d{6}\.\d{3}Z-/

export function prune(root: string, keep: number): string[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root)
  const runs = entries.filter((name) => RUN.test(name)).sort()
  const gone = [...entries.filter((name) => !RUN.test(name)), ...runs.slice(0, Math.max(0, runs.length - keep))]
  for (const name of gone) rmSync(join(root, name), { recursive: true, force: true })
  return gone
}

export function newRun(root: string, at = new Date()): string {
  prune(root, KEEP_RUNS - 1)
  return Evidence.folder(root, 'run', at)
}

export function dropEmpty(run: string): boolean {
  if (!existsSync(run) || readdirSync(run).length) return false
  rmSync(run, { recursive: true, force: true })
  return true
}
