import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { listFiles, shipLeaks, systemTar } from '../npm/scripts/shipped.ts'

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'out' },
    version: { type: 'string' },
  },
})

const problems: string[] = []
const dir = resolve(values.dir!)
const version = values.version ?? ''

function fail(message: string): never {
  console.error(`release guard: ${message}`)
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`--version ${version || '(missing)'}: x.y.z`)
if (!existsSync(dir)) fail(`${dir}: no such directory`)

const archives = [`acde-${version}.tar.gz`]
const PAIRING = 'acdert-version'
const checked = [PAIRING, ...archives]
const allowed = new Set([
  'latest',
  'latest.json',
  'install.sh',
  'install.ps1',
  'install.md',
  `${version}/SHA256SUMS`,
  `${version}/${PAIRING}`,
  ...archives.map((archive) => `${version}/${archive}`),
])

const present = listFiles(dir)
for (const entry of present) {
  if (entry.link) problems.push(`${entry.path}: symbolic link in the release`)
  else if (!allowed.has(entry.path)) problems.push(`${entry.path}: not on the allow-list`)
}
for (const path of allowed) {
  if (!present.some((entry) => entry.path === path)) problems.push(`${path}: missing from the release`)
}

if (problems.length === 0) {
  const latest = readFileSync(join(dir, 'latest'), 'utf8').trim()
  if (latest !== version) problems.push(`latest says ${latest}, the release is ${version}`)

  const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as {
    version?: string
    sdk?: string
    files?: string[]
  }
  if (manifest.version !== version) problems.push(`latest.json says ${manifest.version}, the release is ${version}`)
  const shipped = readdirSync(join(dir, version)).sort()
  if (JSON.stringify([...(manifest.files ?? [])].sort()) !== JSON.stringify(shipped)) {
    problems.push('latest.json does not list exactly the files of the version directory')
  }

  const sums = readFileSync(join(dir, version, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)
  const listed = new Map<string, string>()
  for (const line of sums) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line)
    if (!match) problems.push(`SHA256SUMS: unreadable line ${JSON.stringify(line)}`)
    else listed.set(match[2]!, match[1]!)
  }
  for (const file of checked) {
    const path = join(dir, version, file)
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (listed.get(file) !== hash) problems.push(`${file}: not the checksum SHA256SUMS lists`)
  }
  if (listed.size !== checked.length) {
    problems.push(`SHA256SUMS lists ${listed.size} files, expected ${checked.length}`)
  }
  const acdert = readFileSync(join(dir, version, PAIRING), 'utf8')
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\n$/.test(acdert)) {
    problems.push(`${PAIRING}: not one acdert version line`)
  } else if (acdert.trim() !== manifest.sdk) {
    problems.push(`${PAIRING} says ${acdert.trim()}, latest.json sdk is ${manifest.sdk}`)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'acde-release-guard-'))
  try {
    for (const [index, archive] of archives.entries()) {
      const top = archive.replace(/\.tar\.gz$/, '')
      const file = join(dir, version, archive)
      const verbose = systemTar(['-tvzf', file])
      const plain = systemTar(['-tzf', file])
      if (verbose.status !== 0 || plain.status !== 0) {
        problems.push(`${archive}: cannot be listed`)
        continue
      }
      const rows = verbose.stdout.split('\n').filter(Boolean)
      const names = plain.stdout.split('\n').filter(Boolean)
      if (rows.length !== names.length) problems.push(`${archive}: listings disagree`)
      rows.forEach((row, index) => {
        const type = row[0]
        if (type !== '-' && type !== 'd') problems.push(`${archive}: ${type} entry ${names[index]}`)
      })
      for (const name of names) {
        if (name.startsWith('/') || name.split('/').includes('..')) problems.push(`${archive}: unsafe entry ${name}`)
        if (name !== top && !name.startsWith(`${top}/`)) problems.push(`${archive}: entry ${name} outside ${top}/`)
      }
      const target = join(scratch, String(index))
      mkdirSync(target, { recursive: true })
      const extracted = systemTar(['-xzf', file, '-C', target, '--no-same-owner'])
      if (extracted.status !== 0) {
        problems.push(`${archive}: cannot be unpacked`)
        continue
      }
      const leaks = shipLeaks(join(target, top))
      for (const leak of leaks) problems.push(`${archive}: ${leak}`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (problems.length > 0) {
  console.error(`release guard: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log('release guard: the archive, acdert-version, SHA256SUMS, latest, latest.json, the installers and install.md are listed')
