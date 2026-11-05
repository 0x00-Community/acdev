#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function cli() {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('acde/package.json')), 'src/cli.ts')
  } catch {
    const repo = join(here, '../../src/cli.ts')
    return existsSync(repo) ? repo : null
  }
}

function bun() {
  if (process.versions.bun) return process.execPath
  const found = spawnSync('bun', ['--version'], { stdio: 'ignore' })
  return found.status === 0 ? 'bun' : null
}

const runner = bun()
if (!runner) {
  console.error('acde runs on Bun, and Bun is not installed. Install it (https://bun.sh), then: bun create acde')
  process.exit(1)
}
const entry = cli()
if (!entry) {
  console.error('create-acde: the acde package is missing; reinstall create-acde')
  process.exit(1)
}
const run = spawnSync(runner, [entry, 'new', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(run.status ?? 1)
