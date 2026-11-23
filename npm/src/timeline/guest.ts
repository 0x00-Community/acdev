import { JOURNAL_MOST } from '../vm/logs.ts'

export interface Runner {
  run(argv: readonly string[]): Promise<string>
}

export interface Clock {
  readonly offsetMs: number
  readonly roundTripMs: number
}

export interface JournalRow {
  readonly realtimeUs: number
  readonly monotonicUs: number
  readonly boot: string
  readonly source: string
  readonly message: string
}

export async function guestRunner(): Promise<Runner> {
  const { Machine } = await import('../vm/machine.ts')
  const devd = new Machine().devd()
  return {
    run: async (argv) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      const code = await devd.run(argv, { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) })
      if (code !== 0) throw new Error(`${argv.join(' ')} in the guest exited with ${code}: ${Buffer.concat(err).toString().trim()}`)
      return Buffer.concat(out).toString()
    },
  }
}

export async function measure(guest: Runner, now: () => number = Date.now): Promise<Clock> {
  const sent = now()
  const said = (await guest.run(['/bin/date', '+%s%N'])).trim()
  const back = now()
  const guestMs = Number(BigInt(said) / 1_000_000n)
  return { offsetMs: guestMs - (sent + back) / 2, roundTripMs: back - sent }
}

export function journalCommand(since: Date, until: Date | null): string {
  const to = until ? ` --until @${Math.ceil(until.getTime() / 1000)}` : ''
  return `exec journalctl --no-pager -o json -n ${JOURNAL_MOST} --since @${Math.floor(since.getTime() / 1000)}${to}`
}

export function journalRows(text: string): JournalRow[] {
  const rows: JournalRow[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const message = Array.isArray(entry['MESSAGE']) ? Buffer.from(entry['MESSAGE'] as number[]).toString() : String(entry['MESSAGE'] ?? '')
    const source = String(entry['SYSLOG_IDENTIFIER'] ?? entry['_COMM'] ?? entry['_SYSTEMD_UNIT'] ?? 'journal')
    rows.push({
      realtimeUs: Number(entry['__REALTIME_TIMESTAMP'] ?? 0),
      monotonicUs: Number(entry['__MONOTONIC_TIMESTAMP'] ?? 0),
      boot: String(entry['_BOOT_ID'] ?? ''),
      source,
      message,
    })
  }
  return rows
}

export function jumps(rows: readonly JournalRow[], slackMs = 1000): Set<JournalRow> {
  const moved = new Set<JournalRow>()
  const byBoot = new Map<string, JournalRow[]>()
  for (const row of rows) byBoot.set(row.boot, [...(byBoot.get(row.boot) ?? []), row])
  for (const boot of byBoot.values()) {
    const ordered = [...boot].sort((a, b) => a.monotonicUs - b.monotonicUs)
    for (let i = 1; i < ordered.length; i++) {
      const [before, row] = [ordered[i - 1]!, ordered[i]!]
      const drift = (row.realtimeUs - before.realtimeUs - (row.monotonicUs - before.monotonicUs)) / 1000
      if (Math.abs(drift) > slackMs) moved.add(row)
    }
  }
  return moved
}
