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
    targets: { type: 'string', default: '' },
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

const TARGETS = ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']
const targets = values.targets!.split(',').filter(Boolean)
if (targets.length === 0) fail('--targets: the triples this release ships, comma-separated')
for (const target of targets) if (!TARGETS.includes(target)) fail(`--targets: unknown target ${target} (one of ${TARGETS.join(', ')})`)
const archives = [`acdev-${version}.tar.gz`]
const windows = (target: string) => target.endsWith('-windows-msvc')
const runtimes = targets.map((target) => `acdebin-dbg-${target}${windows(target) ? '.tar.gz' : '.tar.xz'}`)
const host = `acde-host-${version}.tar.gz`
const sdk = `acde-api-${version}.tar.gz`
const checked = [...archives, ...runtimes, host, sdk]
const allowed = new Set([
  'latest',
  'latest.json',
  'install.sh',
  'install.ps1',
  'install.md',
  `${version}/SHA256SUMS`,
  ...checked.map((file) => `${version}/${file}`),
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
  for (const [index, runtime] of runtimes.entries()) {
    const member = windows(targets[index]!) ? 'acdebin-dbg.exe' : 'acdebin-dbg'
    const listing = systemTar([runtime.endsWith('.xz') ? '-tvJf' : '-tvzf', join(dir, version, runtime)])
    const rows = listing.status === 0 ? listing.stdout.split('\n').filter(Boolean) : []
    if (rows.length !== 1 || rows[0]![0] !== '-' || !rows[0]!.endsWith(` ${member}`)) {
      problems.push(`${runtime}: not exactly the one file ${member}`)
    }
  }
  const hostNames = systemTar(['-tzf', join(dir, version, host)])
  const hostList = hostNames.status === 0 ? hostNames.stdout.split('\n').filter(Boolean) : []
  if (!hostList.includes('app/dist/broker.js')) problems.push(`${host}: no app/dist/broker.js`)
  for (const name of hostList) {
    if (name.startsWith('/') || name.split('/').includes('..')) problems.push(`${host}: unsafe entry ${name}`)
    if (/\.(map|ts|tsx)$/.test(name)) problems.push(`${host}: source-like file ${name}`)
  }
  const sdkNames = systemTar(['-tzf', join(dir, version, sdk)])
  const sdkList = sdkNames.status === 0 ? sdkNames.stdout.split('\n').filter(Boolean) : []
  if (!sdkList.includes('package/package.json')) problems.push(`${sdk}: no package/package.json`)
  for (const name of sdkList) if (name !== 'package' && !name.startsWith('package/')) problems.push(`${sdk}: entry ${name} outside package/`)

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
console.log('release guard: the CLI archive, the acdebin-dbg builds, the host files, the SDK, SHA256SUMS, latest, latest.json, the installers and install.md are listed')
