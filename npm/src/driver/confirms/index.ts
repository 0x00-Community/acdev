import type { CallTarget } from '../call/index.ts'

export interface Pending {
  readonly id: string
  readonly op: string
  readonly from: 'agent' | 'user'
}

export interface ConfirmsHost {
  readonly guest: boolean
  call(target: CallTarget, method: string, params?: unknown): Promise<unknown>
}

export const HOST_ONLY = 'approvals: only in a session in the guest (--session vm): system confirms come from the '
  + 'system agent, which a session on this machine does not have'

const ANSWER = 'allow, deny or type the password with act on the confirm window (acdev inspect --all lists it)'

function guest(host: ConfirmsHost): void {
  if (!host.guest) throw new Error(HOST_ONLY)
}

export function pendingOf(answer: unknown): Pending[] {
  if (!Array.isArray(answer)) throw new Error(`the session manager answered approvals.pending with ${JSON.stringify(answer)}`)
  return answer.flatMap((item: { id?: unknown; op?: unknown; from?: unknown } | null) =>
    typeof item?.id === 'string'
      ? [{ id: item.id, op: typeof item.op === 'string' ? item.op : '?', from: item.from === 'agent' ? 'agent' : 'user' }]
      : [])
}

export async function pending(host: ConfirmsHost): Promise<Pending[]> {
  guest(host)
  return pendingOf(await host.call('manager', 'approvals.pending'))
}

export async function show(host: ConfirmsHost, id: string): Promise<string> {
  guest(host)
  const answer = (await host.call('manager', 'approvals.show', { id })) as { shown?: unknown; queued?: unknown } | null
  if (answer?.shown === true) return `the system confirm page shows ${id}: ${ANSWER}`
  if (answer?.queued === true) return `${id} shows once the confirm on the screen now is answered`
  throw new Error(`the session manager answered approvals.show with ${JSON.stringify(answer)}`)
}

export function listed(waiting: readonly Pending[]): string {
  if (waiting.length === 0) return 'no system confirm waits'
  const lines = waiting.map((p) => `${p.id}  ${p.op}  (from ${p.from === 'agent' ? 'an agent' : 'the person'})`)
  return [...lines, 'acdev approvals show <id> puts one on the screen'].join('\n')
}
