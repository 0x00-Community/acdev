#!/usr/bin/env node
// `acde` from npm: runs the runtime binary of this platform's package (@dopame/acde-<os>-<cpu>), like wrangler runs
// workerd's. `acde app …` runs under bun: the bun this package depends on is handed over as ACDE_BUN.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const platform = `@dopame/acde-${process.platform}-${process.arch}`

function binary() {
  if (process.env.ACDE_BINARY) return process.env.ACDE_BINARY
  try {
    return join(dirname(require.resolve(`${platform}/package.json`)), 'bin', 'acde')
  } catch {
    const supported = '@dopame/acde-linux-x64'
    console.error(`acde: no runtime for ${process.platform}-${process.arch} (${platform} is not installed).\nacde runs on Linux x64 for now (${supported}); reinstall without --no-optional if you are on it.`)
    process.exit(1)
  }
}

function bun() {
  if (process.env.ACDE_BUN) return process.env.ACDE_BUN
  try {
    const pkg = dirname(require.resolve('bun/package.json'))
    const { bin } = require('bun/package.json')
    return join(pkg, typeof bin === 'string' ? bin : bin.bun)
  } catch {
    return undefined
  }
}

const env = { ...process.env }
const found = bun()
if (found) env.ACDE_BUN = found
const child = spawn(binary(), process.argv.slice(2), { stdio: 'inherit', env })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
child.on('error', (error) => {
  console.error(`acde: ${error.message}`)
  process.exit(1)
})
