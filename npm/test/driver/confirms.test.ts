import { describe, expect, test } from 'bun:test'
import type { CallTarget } from '../../src/driver/call/index.ts'
import * as Confirms from '../../src/driver/confirms/index.ts'

function host(answers: Record<string, unknown>, guest = true) {
  const calls: [CallTarget, string, unknown][] = []
  const call = (target: CallTarget, method: string, params?: unknown) => {
    calls.push([target, method, params])
    return Promise.resolve(answers[method])
  }
  return { guest, call, calls }
}

describe('system confirms', () => {
  test('lists what waits through the session manager', async () => {
    const said = host({ 'approvals.pending': [{ id: 'r-1', op: 'tool.call', from: 'agent' }, { id: 'r-2', op: 'spend.charge', from: 'user' }, { op: 'x' }] })
    const waiting = await Confirms.pending(said)
    expect(said.calls).toEqual([['manager', 'approvals.pending', undefined]])
    expect(waiting).toEqual([{ id: 'r-1', op: 'tool.call', from: 'agent' }, { id: 'r-2', op: 'spend.charge', from: 'user' }])
    expect(Confirms.listed(waiting).split('\n')).toEqual([
      'r-1  tool.call  (from an agent)', 'r-2  spend.charge  (from the person)', 'acdev approvals show <id> puts one on the screen',
    ])
    expect(Confirms.listed([])).toBe('no system confirm waits')
    expect(() => Confirms.pendingOf({})).toThrow('the session manager answered approvals.pending with {}')
  })

  test('show puts one on the screen, or says it is queued', async () => {
    const shown = host({ 'approvals.show': { shown: true, queued: false } })
    expect(await Confirms.show(shown, 'r-1')).toStartWith('the system confirm page shows r-1: allow, deny or type the password')
    expect(shown.calls).toEqual([['manager', 'approvals.show', { id: 'r-1' }]])
    const queued = host({ 'approvals.show': { shown: false, queued: true } })
    expect(await Confirms.show(queued, 'r-2')).toBe('r-2 shows once the confirm on the screen now is answered')
  })

  test('a session on this machine is refused before anything is sent', async () => {
    const local = host({}, false)
    await expect(Confirms.pending(local)).rejects.toThrow(Confirms.HOST_ONLY)
    await expect(Confirms.show(local, 'r-1')).rejects.toThrow(Confirms.HOST_ONLY)
    expect(local.calls).toEqual([])
  })
})
