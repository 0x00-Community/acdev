import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SELF = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const require = createRequire(join(ROOT, 'package.json'))
const WINDOWS = process.platform === 'win32'
const EXE = WINDOWS ? '.exe' : ''

const BUNS = {
  'darwin-arm64': '@oven/bun-darwin-aarch64',
  'darwin-x64': '@oven/bun-darwin-x64',
  'linux-arm64': '@oven/bun-linux-aarch64',
  'linux-x64': '@oven/bun-linux-x64',
  'linux-arm64-musl': '@oven/bun-linux-aarch64-musl',
  'linux-x64-musl': '@oven/bun-linux-x64-musl',
  'win32-arm64': '@oven/bun-windows-aarch64',
  'win32-x64': '@oven/bun-windows-x64',
}

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl', 'win32-arm64', 'win32-x64']

export function target() {
  const base = `${process.platform}-${process.arch}`
  if (process.platform !== 'linux') return base
  return musl() ? `${base}-musl` : base
}

function musl() {
  try {
    const header = process.report?.getReport?.()?.header
    if (header && 'glibcVersionRuntime' in header) return !header.glibcVersionRuntime
  } catch {}
  try {
    return readdirSync('/lib').some((name) => name.startsWith('ld-musl-'))
  } catch {
    return false
  }
}

export function runtime() {
  if (process.versions.bun) return 'bun'
  if (process.versions.deno || globalThis.Deno) return 'deno'
  return 'node'
}

export const bunPackage = (t = target()) => BUNS[t]
export const acdertPackage = (t = target()) => `@dopame/acdert-${t}`

function cacheRoot() {
  if (process.env.ACDE_CACHE_DIR) return process.env.ACDE_CACHE_DIR
  if (WINDOWS) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'acde', 'cache')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'acde')
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'acde')
}

function which(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of WINDOWS ? ['.exe', '.cmd', ''] : ['']) {
      const file = join(dir, name + ext)
      if (existsSync(file)) return file
    }
  }
  return null
}

function installed(pkg, file) {
  try {
    const path = require.resolve(`${pkg}/${file}`)
    return /\.zip[\\/]/.test(path) || !existsSync(path) ? null : path
  } catch {
    return null
  }
}

function untar(tar, into) {
  let offset = 0
  let longName = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 136).trim() || '0', 8)
    const type = field(156, 157)
    const prefix = field(345, 500)
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type === 'x') {
      const path = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (path) longName = path[1]
      continue
    }
    if (type !== '0' && type !== '') continue
    name = name.replace(/^package\//, '')
    if (name.split('/').includes('..')) throw new Error(`bad path in tarball: ${name}`)
    const file = join(into, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
    chmodSync(file, parseInt(field(100, 108).trim() || '644', 8) & 0o777)
  }
}

export async function fetchPackage(pkg, version, file) {
  const dir = join(cacheRoot(), `${pkg.replace('/', '+')}@${version}`)
  if (existsSync(join(dir, file))) return join(dir, file)
  const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/')
  process.stderr.write(`acde: ${pkg}@${version} is not installed (an optional dependency); downloading it from ${registry}\n`)
  const meta = await fetch(`${registry}${pkg.replace('/', '%2f')}/${version}`)
  if (!meta.ok) throw new Error(`${pkg}@${version}: ${registry} answered ${meta.status}`)
  const { dist } = await meta.json()
  const tarball = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer())
  const [algorithm, expected] = String(dist.integrity || '').split('-', 2)
  if (!algorithm || createHash(algorithm).update(tarball).digest('base64') !== expected) throw new Error(`${pkg}@${version}: the download does not match its integrity`)
  const scratch = `${dir}.${process.pid}`
  rmSync(scratch, { recursive: true, force: true })
  untar(gunzipSync(tarball), scratch)
  if (!existsSync(join(scratch, file))) throw new Error(`${pkg}@${version}: no ${file} in it`)
  rmSync(dir, { recursive: true, force: true })
  renameSync(scratch, dir)
  return join(dir, file)
}

function optional(pkg) {
  return SELF.optionalDependencies?.[pkg] ?? null
}

export async function findBun() {
  if (process.versions.bun) return process.execPath
  const pkg = bunPackage()
  const file = `bin/bun${EXE}`
  const local = pkg && installed(pkg, file)
  if (local) return local
  const onPath = which('bun')
  if (onPath) return onPath
  const version = pkg && optional(pkg)
  if (version) return fetchPackage(pkg, version, file)
  throw new Error(`acde needs Bun and found none: install it (https://bun.sh)${pkg ? '' : `; Bun has no build for ${target()}`}`)
}

export async function findAcdert(needed) {
  if (process.env.ACDERT) return process.env.ACDERT
  const pkg = acdertPackage()
  const file = `bin/acdert${EXE}`
  const local = installed(pkg, file)
  if (local) return local
  const onPath = which('acdert')
  if (onPath) return onPath
  const version = optional(pkg)
  if (needed && version) return fetchPackage(pkg, version, file)
  if (needed && SELF.optionalDependencies) throw new Error(`acdert has no build for ${target()} yet (acde ${SELF.version}); set ACDERT to an acdert you built`)
  return null
}

export async function run(args) {
  const bun = await findBun()
  const acdert = await findAcdert(args[0] === 'dev')
  const env = {
    ...process.env,
    PATH: `${dirname(bun)}${delimiter}${process.env.PATH || ''}`,
    ACDE_HOST_RUNTIME: process.env.ACDE_HOST_RUNTIME || runtime(),
    ...(acdert && { ACDERT: acdert }),
  }
  const cli = ['cli.js', 'cli.ts'].map((name) => join(ROOT, 'src', name)).find((file) => existsSync(file))
  const child = spawn(bun, [cli, ...args], { stdio: 'inherit', env })
  process.on('SIGINT', () => {})
  if (!WINDOWS) for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  return new Promise((done) => {
    child.on('error', (error) => {
      process.stderr.write(`acde: ${bun}: ${error.message}\n`)
      done(1)
    })
    child.on('exit', (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 0)))
  })
}
