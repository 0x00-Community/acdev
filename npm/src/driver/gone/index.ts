import { setTimeout as sleep } from 'node:timers/promises'

export const LOOKS: ReadonlySet<string> = new Set(['webs', 'snapshot', 'query', 'console', 'network', 'permissions'])
export const WAIT_MS = 20_000
export const STEP_MS = 200

export interface Pace {
  readonly now: () => number
  readonly pause: (ms: number) => Promise<unknown>
}

export interface Asking {
  readonly op: string
  readonly guest: boolean
  readonly waitMs?: number
  readonly pace?: Pace
}

const REAL: Pace = { now: () => Date.now(), pause: (ms) => sleep(ms) }
const NOT_SENT = /(?:^|: )no page \S|has no page/

export function lookAgain(op: string, error: unknown): boolean {
  return LOOKS.has(op) && error instanceof Error && error.message === 'the page went away'
}

export function notSent(error: unknown): boolean {
  return error instanceof Error && NOT_SENT.test(error.message)
}

export async function ask<T>(send: () => Promise<T>, { op, guest, waitMs = WAIT_MS, pace = REAL }: Asking): Promise<T> {
  const started = pace.now()
  let lookedAgain = false
  for (;;) {
    try {
      return await send()
    } catch (error) {
      if (guest && !lookedAgain && lookAgain(op, error)) {
        lookedAgain = true
        continue
      }
      if (!notSent(error)) throw error
      const waited = pace.now() - started
      if (waited >= waitMs) {
        const seconds = Math.round(waited / 100) / 10
        throw new Error(`${(error as Error).message} (waited ${seconds} s for the page to come back; it did not)`, { cause: error })
      }
      await pace.pause(Math.min(STEP_MS, waitMs - waited))
    }
  }
}
