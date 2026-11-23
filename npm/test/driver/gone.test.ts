import { describe, expect as check, test } from 'bun:test'
import * as Gone from '../../src/driver/gone/index.ts'

const paced = () => {
  let clock = 0
  const pauses: number[] = []
  const pause = async (ms: number) => {
    clock += ms
    pauses.push(clock)
  }
  return { pauses, pace: { now: () => clock, pause } }
}

const answering = (failures: readonly string[], value = 'answered') => {
  const asked: number[] = []
  const send = async () => {
    asked.push(asked.length)
    const failure = failures[asked.length - 1]
    if (failure !== undefined) throw new Error(failure)
    return value
  }
  return { asked, send }
}

describe('Gone.ask', () => {
  test('a page that is briefly not there is waited for and the request then answers', async () => {
    const { pace, pauses } = paced()
    const { asked, send } = answering(['eval: no page desktop', 'eval: no page desktop'])
    check(await Gone.ask(send, { op: 'eval', guest: true, pace })).toBe('answered')
    check(asked.length).toBe(3)
    check(pauses).toEqual([Gone.STEP_MS, 2 * Gone.STEP_MS])
  })

  test('a page that never comes back fails after the wait, saying how long it waited', async () => {
    const { pace } = paced()
    const { asked, send } = answering(Array(1000).fill('snapshot: no page desktop'))
    const failed = Gone.ask(send, { op: 'snapshot', guest: true, waitMs: 1_000, pace })
    await check(failed).rejects.toThrow('snapshot: no page desktop (waited 1 s for the page to come back; it did not)')
    check(asked.length).toBe(6)
  })

  test('a window whose page is still loading is waited for like a missing page', async () => {
    const { pace } = paced()
    const { send } = answering(['window 7 has no page'])
    check(await Gone.ask(send, { op: 'shot', guest: false, pace })).toBe('answered')
  })

  test('an act or eval that reached the page and failed there is not sent again', async () => {
    const { pace } = paced()
    for (const op of ['act', 'eval']) {
      const { asked, send } = answering(['the page went away'])
      await check(Gone.ask(send, { op, guest: true, pace })).rejects.toThrow('the page went away')
      check(asked.length).toBe(1)
    }
    const { asked, send } = answering(['no web "nope"'])
    await check(Gone.ask(send, { op: 'eval', guest: true, pace })).rejects.toThrow('no web "nope"')
    check(asked.length).toBe(1)
  })

  test('a look whose guest page went away is asked once more, only in the guest', async () => {
    const { pace } = paced()
    const again = answering(['the page went away'])
    check(await Gone.ask(again.send, { op: 'snapshot', guest: true, pace })).toBe('answered')
    check(again.asked.length).toBe(2)
    const twice = answering(['the page went away', 'the page went away'])
    await check(Gone.ask(twice.send, { op: 'snapshot', guest: true, pace })).rejects.toThrow('the page went away')
    const host = answering(['the page went away'])
    await check(Gone.ask(host.send, { op: 'snapshot', guest: false, pace })).rejects.toThrow('the page went away')
    check(host.asked.length).toBe(1)
  })
})
