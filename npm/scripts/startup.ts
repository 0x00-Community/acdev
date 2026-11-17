import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', default: '7' },
    'max-version-ms': { type: 'string' },
    'max-help-ms': { type: 'string' },
  },
})

const acde = positionals[0] ?? 'acdev'
const runs = Math.max(2, Number(values.runs) || 7)
const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(acde)

function median(args: readonly string[]): number {
  const times: number[] = []
  for (let i = 0; i <= runs; i++) {
    const started = performance.now()
    const ran = spawnSync(shell ? `"${acde}" ${args.join(' ')}` : acde, shell ? [] : args, {
      stdio: 'ignore', shell, windowsHide: true, timeout: 60_000,
    })
    if (ran.error) throw new Error(`${acde} ${args.join(' ')}: ${ran.error.message}`)
    if (ran.status !== 0) throw new Error(`${acde} ${args.join(' ')} exited with ${ran.status}`)
    if (i > 0) times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  return Math.round(times[Math.floor(times.length / 2)]!)
}

const checks: [string, readonly string[], string | undefined][] = [
  ['acdev -v', ['-v'], values['max-version-ms']],
  ['acdev --help', ['--help'], values['max-help-ms']],
]
let slow = false
for (const [name, args, max] of checks) {
  const ms = median(args)
  const over = max !== undefined && ms > Number(max)
  slow ||= over
  console.log(`${name}: ${ms} ms (median of ${runs}, after one warm-up run)${over ? `, over ${max} ms` : ''}`)
}
process.exit(slow ? 1 : 0)
