export interface Check {
  readonly rule: number
  readonly text: string
  readonly hit: boolean
  readonly why: string
}

export interface Explained {
  readonly facts: Readonly<Record<string, unknown>>
  readonly checks: readonly Check[]
  readonly action: { readonly do: string; readonly fallback?: string | null; readonly rule: number | null }
  readonly review?: { readonly verdict: string; readonly reason: string; readonly cites?: readonly string[] }
  readonly note?: string
}

export interface Caller {
  call(to: 'manager', method: string, params: unknown): Promise<unknown>
}

export async function explain(acde: Caller, id: string): Promise<Explained> {
  if (!id.trim()) throw new Error('explain: needs an audit id (the id of a record in the system agent\'s audit)')
  const explained = (await acde.call('manager', 'audit.show', { id })) as Explained | null
  if (!explained || !Array.isArray(explained.checks)) throw new Error(`explain ${id}: the session answered ${JSON.stringify(explained)}`)
  return explained
}

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

export function text(id: string, explained: Explained): string {
  const facts = Object.entries(explained.facts ?? {}).map(([name, value]) => `  ${name}: ${shown(value)}`)
  const checks = explained.checks.map((c) => `  rule ${c.rule}: ${c.hit ? 'hit' : 'no'}: ${c.why}\n    ${c.text}`)
  const { action } = explained
  const by = action.rule === null ? 'the default, no rule hit' : `rule ${action.rule}`
  const fallback = action.fallback ? `, fallback ${action.fallback}` : ''
  const lines = [`audit ${id}`, 'facts:', ...(facts.length ? facts : ['  (none)']), 'rules:', ...checks, `action: ${action.do}${fallback} (${by})`]
  const review = explained.review
  if (review) lines.push(`review: ${review.verdict}: ${review.reason}${review.cites?.length ? ` (cites ${review.cites.join(', ')})` : ''}`)
  if (explained.note) lines.push(`note: ${explained.note}`)
  return lines.join('\n')
}
