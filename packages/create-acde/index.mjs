#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function launcher() {
  try {
    return await import('acde/launcher')
  } catch (error) {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '../../launcher.mjs')
    if (existsSync(repo)) return import(pathToFileURL(repo).href)
    throw error
  }
}

try {
  const { run } = await launcher()
  process.exit(await run(['new', ...process.argv.slice(2)]))
} catch (error) {
  process.stderr.write(`create-acde: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
