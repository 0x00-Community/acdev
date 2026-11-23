import { describe, expect as check, test } from 'bun:test'
import { join } from 'node:path'
import * as Timeline from '../../src/timeline/index.ts'
import * as Guest from '../../src/timeline/guest.ts'
import * as HostLog from '../../src/timeline/hostlog.ts'
import { tmp } from '../helpers.ts'

const journalLine = (realtimeMs: number, monotonicMs: number, source: string, message: string) =>
  JSON.stringify({
    __REALTIME_TIMESTAMP: String(realtimeMs * 1000),
    __MONOTONIC_TIMESTAMP: String(monotonicMs * 1000),
    _BOOT_ID: 'b1',
    SYSLOG_IDENTIFIER: source,
    MESSAGE: message,
  })

describe('the timeline', () => {
  test('the guest clock is put on the host by the middle of one round trip', async () => {
    let now = 1_000
    const guest: Guest.Runner = {
      run: async () => {
        now += 40
        return `${BigInt(5_000_020) * 1_000_000n}\n`
      },
    }
    const clock = await Guest.measure(guest, () => now)
    check(clock).toEqual({ offsetMs: 5_000_020 - 1_020, roundTripMs: 40 })
  })

  test('journal rows keep their source and event kind, and a clock that moved is marked', () => {
    const rows = Guest.journalRows([
      journalLine(10_000, 100, 'acdes', 'acompositor: event=press window=4'),
      'not json',
      journalLine(10_050, 150, 'bun', 'dopame_backend: tool-result ok'),
      journalLine(70_000, 200, 'acdes', 'manager: event=call service=fs'),
    ].join('\n'))
    const events = Timeline.fromJournal(rows, 2_000)
    check(events.map((e) => [e.at, e.from, e.kind, e.clockMoved ?? false])).toEqual([
      [8_000, 'acdes', 'press', false], [8_050, 'bun', 'log', false], [68_000, 'acdes', 'call', true],
    ])
  })

  test('all sources merge in time order, on the host clock, and filter by time, source, kind and window', () => {
    const journal = Timeline.fromJournal(Guest.journalRows(journalLine(10_300, 1, 'acdes', 'manager: event=invoke window=4 page=notes#4')), 1_000)
    const pages = Timeline.fromPages(
      [{ seq: 1, time: 5, at: 10_150, web: 'notes#4', app: 'notes', kind: 'console', level: 'warn', text: 'slow' }],
      [{ seq: 1, time: 9, at: 10_400, web: 'notes#4', app: 'notes', id: 1, kind: 'fetch', method: 'GET', url: '/a', requestBytes: 0,
        status: 200, statusText: 'OK', responseBytes: 1, ms: 3, error: null, done: true }],
      1_000,
    )
    const host = Timeline.fromHost([{ at: 9_200, ms: 30, ok: true, title: 'act("w4.2", "click")', text: '' }])
    const window = { since: new Date(9_000), until: new Date(9_400) }
    const all = Timeline.select([...journal, ...pages, ...host], window)
    check(all.map((e) => `${e.at} ${e.source} ${e.kind}`)).toEqual(['9150 console warn', '9200 host act', '9300 journal invoke', '9400 network fetch'])
    check(Timeline.select(all, window, { sources: ['journal', 'host'] }).length).toBe(2)
    check(Timeline.select(all, window, { kinds: ['fetch'] }).map((e) => e.text)).toEqual(['GET /a 200 3 ms'])
    check(Timeline.select(all, window, { window: 'w4' }).map((e) => e.source)).toEqual(['journal'])
    check(Timeline.select(all, window, { window: 'notes#4' }).map((e) => e.source)).toEqual(['console', 'network'])
  })

  test('gather reads what it can, says what it could not, and writes text and JSON', async () => {
    const dir = tmp()
    const log = join(dir, 'host.jsonl')
    HostLog.append(log, { at: 9_500, ms: 2, ok: false, title: 'act("w1.3", "key", "Enter")', text: 'w1.3 is gone' })
    const scene: Timeline.Scene = {
      console: async () => Promise.reject(new Error('no page desktop')),
      network: async () => ({ entries: [], next: 1, dropped: 0 }),
    }
    const timeline = await Timeline.gather({ scene, guest: null, hostLog: log, window: { since: new Date(9_000), until: null } }, {})
    check(timeline.missing).toEqual(['console: no page desktop'])
    const lines = Timeline.text(timeline).split('\n')
    check(lines[1]).toBe('clock: one machine, one clock')
    check(lines.at(-1)).toContain('host:acdev act act("w1.3", "key", "Enter") FAIL 2 ms: w1.3 is gone')
    check(JSON.parse(Timeline.json(timeline)).events[0].source).toBe('host')
    const feed: Timeline.Feed = { source: 'journal', events: async () => [{ at: 9_600, source: 'journal', from: 'manager', kind: 'timeline', text: 'x' }] }
    const fed = await Timeline.gather({ scene: null, guest: null, hostLog: null, window: { since: new Date(0), until: null }, feeds: [feed] })
    check(fed.events.length).toBe(1)
  })

  test('the command line flags become the window and the filter', () => {
    const parse = (given: string | undefined) => new Date(given === undefined ? 0 : Number(given))
    const { window, filter } = Timeline.fromFlags(new Map([['since', '100'], ['source', 'host,journal'], ['kind', 'call'], ['window', 'w3']]), parse)
    check([window.since.getTime(), window.until, filter]).toEqual([100, null, { sources: ['host', 'journal'], kinds: ['call'], window: 'w3' }])
    check(() => Timeline.fromFlags(new Map([['source', 'radio']]), parse)).toThrow('timeline: --source radio')
  })
})
