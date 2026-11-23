import { RequestError } from '../../ipc.ts'

export type CallTarget = 'manager' | 'desktop'

export const TARGETS: readonly CallTarget[] = ['manager', 'desktop']

export const HOST_ONLY = 'call: only in a session in the guest (--session vm): a session on this machine has no '
  + 'session manager and no Dopame backend to call'

export function target(given: string): CallTarget {
  if ((TARGETS as readonly string[]).includes(given)) return given as CallTarget
  throw new Error(`call: ${given} is not a target (${TARGETS.join(' or ')}) (acdev call --help)`)
}

export function params(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`call: the parameters are not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function failed(to: CallTarget, method: string, error: unknown): Error {
  const said = error instanceof Error ? error.message : String(error)
  const code = error instanceof RequestError && error.code !== null ? ` (code ${error.code})` : ''
  return new Error(`call ${to} ${method}: ${said}${code}`, { cause: error })
}

export interface CallHost {
  readonly guest: boolean
  readonly trace: { step<T>(title: string, run: () => Promise<T>): Promise<T> }
  request(body: Readonly<Record<string, unknown>>): Promise<unknown>
}

export function run(host: CallHost, to: CallTarget, method: string, given?: unknown): Promise<unknown> {
  if (!host.guest) return Promise.reject(new Error(HOST_ONLY))
  const body = { target: to, method, ...(given !== undefined && { params: given }) }
  return host.trace.step(`call(${JSON.stringify(to)}, ${JSON.stringify(method)})`, () =>
    host.request(body).catch((error: unknown) => Promise.reject(failed(to, method, error))))
}
