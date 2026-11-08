import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WINDOWS = process.platform === 'win32'
const EXE = WINDOWS ? '.exe' : ''
export const NODE_MINIMUM = [22, 3]

export function runtime() {
  return process.versions.bun ? 'bun' : 'node'
}

export function installDir(env = process.env) {
  return env.ACDE_INSTALL || join(homedir(), '.acde')
}

export function installed(root = ROOT) {
  return basename(dirname(root)) === 'lib' && existsSync(join(root, '..', 'acde-api', 'package.json'))
}

export function which(name, env = process.env) {
  const exts = WINDOWS && !/\.[^\\/.]+$/.test(name) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const dir of (env.PATH || env.Path || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, name + ext)
      try {
        if (statSync(file).isFile()) return file
      } catch {}
    }
  }
  return null
}

export function acdertCheckouts(root = ROOT) {
  return ['release', 'debug'].map((profile) => join(root, '..', 'acdert', 'target', profile, `acdert${EXE}`))
}

function places(root) {
  const own = installed(root) ? [join(root, '..', '..', 'bin', `acdert${EXE}`)] : []
  const global = join(installDir(), WINDOWS ? join('current', 'bin') : 'bin', `acdert${EXE}`)
  const real = (path) => {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
  return {
    checkouts: installed(root) ? [] : acdertCheckouts(root),
    installs: own.some((path) => real(path) === real(global)) ? own : [...own, global],
  }
}

export function requireAcdert(root = ROOT) {
  const set = process.env.ACDERT
  if (set) {
    if (existsSync(set)) return set
    const named = /[\\/]/.test(set) ? null : which(set)
    if (named) return named
    throw new Error(`ACDERT=${set}: no such file; point ACDERT at an acdert binary, or unset it to let acde look for one`)
  }
  const { checkouts, installs } = places(root)
  const found = [...checkouts, ...installs].find((path) => existsSync(path)) ?? which('acdert')
  if (found) return found
  const looked = ['  ACDERT (not set)', ...checkouts.map((path) => `  ${path} (not built)`), ...installs.map((path) => `  ${path} (not there)`), `  PATH (no acdert${EXE} in it)`]
  const fix = checkouts.length
    ? `, build the acdert checkout next to acde (cd ${join(root, '..', 'acdert')} && cargo build --release -p acdert)`
    : ', install acde again (it brings acdert along)'
  throw new Error(`no acdert found. Looked in:\n${looked.join('\n')}\nSet ACDERT to an acdert you built (ACDERT=/path/to/acdert acde dev)${fix}, or put acdert on PATH`)
}

export function cliFile(root = ROOT) {
  return ['cli.js', 'cli.ts'].map((name) => join(root, 'src', name)).find((file) => existsSync(file))
}

export function cliRuntime(root = ROOT) {
  if (process.versions.bun) return process.execPath
  if (cliFile(root)?.endsWith('.ts')) return which('bun') ?? process.execPath
  return process.execPath
}

export function cliEnv(exe, env = process.env) {
  return {
    ...env,
    PATH: `${dirname(exe)}${delimiter}${env.PATH || ''}`,
    ACDE_HOST_RUNTIME: env.ACDE_HOST_RUNTIME || runtime(),
  }
}

function checkNode() {
  if (process.versions.bun) return
  const [major, minor] = process.versions.node.split('.').map(Number)
  const [needMajor, needMinor] = NODE_MINIMUM
  if (major < needMajor || (major === needMajor && minor < needMinor)) throw new Error(`acde needs Node.js ${NODE_MINIMUM.join('.')} or newer (this is ${process.version}), or Bun (https://bun.sh)`)
}

export function run(args) {
  checkNode()
  const exe = cliRuntime()
  const child = spawn(exe, [cliFile(), ...args], { stdio: 'inherit', env: cliEnv(exe) })
  process.on('SIGINT', () => {})
  if (!WINDOWS) for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  return new Promise((done) => {
    child.on('error', (error) => {
      process.stderr.write(`acde: ${exe}: ${error.message}\n`)
      done(1)
    })
    child.on('exit', (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 0)))
  })
}
