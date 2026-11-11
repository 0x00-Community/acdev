import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WINDOWS = process.platform === 'win32'
const EXE = WINDOWS ? '.exe' : ''
export const NODE_MINIMUM = [22, 3]
export const BUN_MINIMUM = [1, 4]

export function packageRoot() {
  return ROOT
}

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
  const exts = WINDOWS && !/\.[^\\/.]+$/.test(name)
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
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

export function acdertBeside(root = ROOT) {
  return installed(root) ? join(root, '..', '..', 'bin', `acdert${EXE}`) : null
}

export function findAcdert(root = ROOT, env = process.env) {
  const set = env.ACDERT
  if (set) {
    if (existsSync(set)) return { path: set, from: 'ACDERT' }
    const named = /[\\/]/.test(set) ? null : which(set, env)
    if (named) return { path: named, from: 'ACDERT' }
    return { path: null, from: 'ACDERT', problem: `ACDERT=${set}: no such file; point ACDERT at an acdert binary, or unset it` }
  }
  const beside = acdertBeside(root)
  if (beside && existsSync(beside)) return { path: beside, from: 'install' }
  const found = which(`acdert${EXE}`, env)
  if (found) return { path: found, from: 'PATH' }
  const missing = beside ? `no ${beside}, which the acde installer puts there: run the installer again, ` : ''
  return {
    path: null,
    from: null,
    problem: `acde dev needs the Dopame runtime (acdert) and found none: ${missing}` +
      'set ACDERT to an acdert binary, or put acdert on PATH',
  }
}

export function requireAcdert(root = ROOT, env = process.env) {
  const found = findAcdert(root, env)
  if (found.path) return found.path
  throw new Error(`${found.problem} (acde doctor checks the whole setup)`)
}

export function atLeast(version, minimum) {
  const [major, minor] = version.split('.').map(Number)
  const [needMajor, needMinor] = minimum
  return major > needMajor || (major === needMajor && minor >= needMinor)
}

function probe(name, args, minimum, env) {
  const found = which(`${name}${EXE}`, env)
  const out = found ? spawnSync(found, args, { encoding: 'utf8' }) : null
  return out?.status === 0 && atLeast(out.stdout.trim(), minimum) ? found : null
}

export function runtimes(env = process.env) {
  if (process.versions.bun) {
    const node = probe('node', ['-p', "process.versions.bun ? '' : process.versions.node"], NODE_MINIMUM, env)
    return { bun: process.execPath, node }
  }
  return { bun: probe('bun', ['--version'], BUN_MINIMUM, env), node: process.execPath }
}

export function cliFile(root = ROOT) {
  return [join(root, 'dist', 'cli.js'), join(root, 'src', 'cli.ts')].find((file) => existsSync(file))
}

export function cliRuntime(root = ROOT) {
  if (process.versions.bun) return process.execPath
  if (cliFile(root)?.endsWith('.ts')) return which('bun') ?? process.execPath
  return process.execPath
}

export function cliEnv(exe, env = process.env, platform = process.platform) {
  const out = { ...env }
  const isPath = (name) => (platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH')
  const names = Object.keys(out).filter(isPath)
  const path = names.length > 0 ? out[names.at(-1)] : undefined
  for (const name of names) delete out[name]
  return {
    ...out,
    PATH: `${dirname(exe)}${delimiter}${path || ''}`,
    ACDE_HOST_RUNTIME: env.ACDE_HOST_RUNTIME || runtime(),
  }
}

function checkRuntime() {
  if (process.versions.bun) {
    if (!atLeast(process.versions.bun, BUN_MINIMUM)) {
      throw new Error(`acde needs Bun ${BUN_MINIMUM.join('.')} or newer (this is ${process.versions.bun}): ` +
        'update it (bun upgrade, or https://bun.sh)')
    }
    return
  }
  if (!atLeast(process.versions.node, NODE_MINIMUM)) {
    throw new Error(`acde needs Node.js ${NODE_MINIMUM.join('.')} or newer (this is ${process.version}): ` +
      'update it (https://nodejs.org)')
  }
}

export function run(args, exe = cliRuntime()) {
  checkRuntime()
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
