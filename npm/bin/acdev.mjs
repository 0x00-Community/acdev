#!/usr/bin/env node
import { run } from '../launcher.mjs'

try {
  process.exit(await run(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`acdev: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
