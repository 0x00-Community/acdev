import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SOURCE_DIRECTORIES = ['lib/acdev/src', 'lib/acdev/test', 'lib/acde-api/test', 'bin/app/src']
const FORBIDDEN_SEGMENTS = new Set([
  'fixtures', '__fixtures__', '__snapshots__', '__screenshots__', 'test-results', 'test', 'tests', 'logs', 'coverage',
])
const FORBIDDEN_NAME = /\.(map|pdb|dwp|debug|dbg|log)$/i
const DECLARATION = /\.d\.[cm]?ts$/
const TYPESCRIPT = /\.[cm]?tsx?$/
const CONTENT_RULES: [RegExp, string][] = [
  [/sourcesContent/, 'sourcesContent'],
  [/sourceMappingURL/, 'source map reference'],
  [/sourceURL=(?!\$\{)/, 'sourceURL naming a file'],
  [/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/aws_secret_access_key/i, 'AWS secret key name'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key'],
  [/Projects[\\/]AgentComputer|Users[\\/]Akira|AKIRA-LT|\/d\/Projects\/|home\/runner\/work/, 'local build path'],
]

export interface Entry {
  readonly path: string
  readonly link: boolean
  readonly file: string
}

export function listFiles(root: string): Entry[] {
  const found: Entry[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      const stat = lstatSync(file)
      const path = relative(root, file).split(sep).join('/')
      if (stat.isSymbolicLink()) found.push({ path, link: true, file })
      else if (stat.isDirectory()) walk(file)
      else found.push({ path, link: false, file })
    }
  }
  walk(root)
  return found
}

export function shipLeaks(root: string): string[] {
  const found = SOURCE_DIRECTORIES
    .filter((dir) => existsSync(join(root, dir)))
    .map((dir) => `${dir}: source directory`)
  for (const entry of listFiles(root)) {
    const { path } = entry
    const segments = path.split('/')
    if (entry.link) {
      found.push(`${path}: symbolic link`)
      continue
    }
    if (segments.some((segment) => segment.startsWith('.') || segment.endsWith('.dSYM'))) {
      found.push(`${path}: dotfile or symbol bundle`)
    }
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      found.push(`${path}: test, fixture or log directory`)
    }
    if (FORBIDDEN_NAME.test(path)) found.push(`${path}: source map, symbol or log file`)
    if (TYPESCRIPT.test(path) && !DECLARATION.test(path) && !path.startsWith('lib/acdev/templates/')) {
      found.push(`${path}: TypeScript source`)
    }
    const text = readFileSync(entry.file).toString('latin1')
    for (const [pattern, what] of CONTENT_RULES) if (pattern.test(text)) found.push(`${path}: ${what}`)
  }
  return found
}

export function systemTar(args: string[]) {
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const exe = process.platform === 'win32' ? join(systemRoot, 'System32', 'tar.exe') : 'tar'
  return spawnSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
