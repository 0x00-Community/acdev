import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const BACKEND_DIR = '/usr/lib/dopame/backend'

export interface BackendBuild {
  readonly args: readonly string[]
  readonly output: string
}

export interface BackendInstall {
  readonly mode: string
  readonly sources: readonly string[]
  readonly target: string
}

export interface BackendPlan {
  readonly builds: readonly BackendBuild[]
  readonly installs: readonly BackendInstall[]
}

function body(pkgbuild: string, name: string): string {
  const start = pkgbuild.search(new RegExp(`^${name}\\(\\)\\s*\\{`, 'm'))
  if (start < 0) return ''
  const end = pkgbuild.slice(start).search(/^\}/m)
  return end < 0 ? pkgbuild.slice(start) : pkgbuild.slice(start, start + end)
}

function plain(token: string): boolean {
  return !/[$"'`\\]/.test(token)
}

export function backendBuilds(pkgbuild: string): BackendBuild[] {
  const builds: BackendBuild[] = []
  for (const line of body(pkgbuild, 'build').split('\n')) {
    const words = line.trim().split(/\s+/)
    if (words[0] !== 'bun' || words[1] !== 'build' || !words.every(plain)) continue
    const at = words.indexOf('--outfile')
    const output = at > 0 ? words[at + 1] : undefined
    if (output?.startsWith('backend/')) builds.push({ args: words.slice(1), output })
  }
  return builds
}

export function backendInstalls(pkgbuild: string): BackendInstall[] {
  const installs: BackendInstall[] = []
  const line = /^\s*install\s+-Dm(\d{3,4})\s+(.+?)\s+-t\s+"\$\{pkgdir\}([^"]*)"\s*$/
  for (const text of body(pkgbuild, 'package').split('\n')) {
    const found = line.exec(text)
    if (!found) continue
    const [, mode, sources, target] = found as unknown as [string, string, string, string]
    const words = sources.split(/\s+/)
    if ((target === BACKEND_DIR || target.startsWith(`${BACKEND_DIR}/`)) && words.every(plain)) installs.push({ mode, sources: words, target })
  }
  return installs
}

export function backendPlan(pkgbuild: string): BackendPlan {
  return { builds: backendBuilds(pkgbuild), installs: backendInstalls(pkgbuild) }
}

export function expand(repo: string, source: string): string[] {
  if (!source.includes('*')) return [source]
  const dir = dirname(source)
  const pattern = new RegExp(`^${basename(source).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`)
  const names = existsSync(join(repo, dir)) ? readdirSync(join(repo, dir)).filter((name) => pattern.test(name)).sort() : []
  return names.map((name) => join(dir, name))
}

function bun(): string {
  return process.versions['bun'] ? process.execPath : 'bun'
}

function build(repo: string, { args, output }: BackendBuild, out: string): string {
  const file = join(out, 'backend', output)
  mkdirSync(dirname(file), { recursive: true })
  const wanted = args.map((arg, i) => (args[i - 1] === '--outfile' ? file : arg))
  const made = spawnSync(bun(), wanted, { cwd: repo, encoding: 'utf8' })
  if (made.status !== 0) {
    const said = `${made.error?.message ?? ''}${made.stderr ?? ''}`.trim().split('\n').slice(-3).join(' / ')
    throw new Error(`vm provision: bun ${args.join(' ')} (from the dopame PKGBUILD build()) failed in ${repo}: ${said}`)
  }
  return file
}

export function stageBackend(repo: string, out: string): number {
  const pkgbuild = join(repo, 'packaging', 'arch', 'PKGBUILD')
  if (!existsSync(pkgbuild)) return 0
  const { builds, installs } = backendPlan(readFileSync(pkgbuild, 'utf8'))
  if (!installs.length) return 0
  const built = new Map(builds.map((step) => [step.output, build(repo, step, out)]))
  const lines: string[] = []
  for (const { mode, sources, target } of installs) {
    for (const source of sources) {
      const files = expand(repo, source)
      if (!files.length) throw new Error(`vm provision: the dopame PKGBUILD installs ${source}, but ${join(repo, source)} matches nothing`)
      for (const file of files) {
        const from = built.get(file) ?? join(repo, file)
        if (!existsSync(from)) throw new Error(`vm provision: the dopame PKGBUILD installs ${file}, but ${from} does not exist`)
        const staged = join('backend', file)
        if (from !== join(out, staged)) {
          mkdirSync(dirname(join(out, staged)), { recursive: true })
          cpSync(from, join(out, staged))
        }
        lines.push(`${mode}\t${staged}\t${target}`)
      }
    }
  }
  writeFileSync(join(out, 'backend.install'), lines.map((line) => `${line}\n`).join(''))
  return lines.length
}

export const BACKEND_SCRIPT = [
  '  if [ -f "$here/dopame/backend.install" ]; then',
  '    while IFS="$(printf "\\t")" read -r mode file target; do',
  '      install -Dm"$mode" "$here/dopame/$file" -t "$target"',
  '    done <"$here/dopame/backend.install"',
  '  fi',
]

export interface DropIn {
  readonly mode: string
  readonly source: string
  readonly target: string
}

export function dropIns(pkgbuild: string): DropIn[] {
  const line = /^\s*install\s+-Dm(\d{3,4})\s+(\S+)\s+"\$\{pkgdir\}(\/usr\/lib\/systemd\/system\/[^/"]+\.service\.d\/[^/"]+\.conf)"\s*$/
  const found: DropIn[] = []
  for (const text of body(pkgbuild, 'package').replace(/\\\n\s*/g, ' ').split('\n')) {
    const match = line.exec(text)
    if (match && plain(match[2]!)) found.push({ mode: match[1]!, source: match[2]!, target: match[3]! })
  }
  return found
}

export function stageDropIns(repo: string, out: string): number {
  const pkgbuild = join(repo, 'packaging', 'arch', 'PKGBUILD')
  if (!existsSync(pkgbuild)) return 0
  const lines: string[] = []
  for (const { mode, source, target } of dropIns(readFileSync(pkgbuild, 'utf8'))) {
    const from = join(repo, source)
    if (!existsSync(from)) throw new Error(`vm provision: the dopame PKGBUILD installs ${source} as ${target}, but ${from} does not exist`)
    const staged = join('units', String(lines.length), basename(source))
    mkdirSync(dirname(join(out, staged)), { recursive: true })
    cpSync(from, join(out, staged))
    lines.push(`${mode}\t${staged}\t${target}`)
  }
  if (lines.length) writeFileSync(join(out, 'units.install'), lines.map((l) => `${l}\n`).join(''))
  return lines.length
}

export const DROPIN_SCRIPT = [
  '  if [ -f "$here/dopame/units.install" ]; then',
  '    while IFS="$(printf "\\t")" read -r mode file target; do',
  '      install -Dm"$mode" "$here/dopame/$file" "$target"',
  '    done <"$here/dopame/units.install"',
  '    systemctl daemon-reload',
  '  fi',
]

const LAID_OUT = ['acdes']

export function dopameDepends(pkgbuild: string): string[] {
  const found = /^depends=\(([^)]*)\)/m.exec(pkgbuild)
  if (!found) return []
  const words = found[1]!.split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, '')).filter(Boolean)
  return words.filter((word) => plain(word) && !LAID_OUT.includes(word.split(/[<>=]/)[0]!))
}

export function stageDepends(repo: string, out: string): number {
  const pkgbuild = join(repo, 'packaging', 'arch', 'PKGBUILD')
  const depends = existsSync(pkgbuild) ? dopameDepends(readFileSync(pkgbuild, 'utf8')) : []
  if (depends.length) writeFileSync(join(out, 'depends'), depends.map((name) => `${name}\n`).join(''))
  return depends.length
}

export const DEPENDS_SCRIPT = [
  '  if [ -f "$here/dopame/depends" ]; then',
  '    missing=$(pacman -T $(cat "$here/dopame/depends") || true)',
  '    if [ -n "$missing" ]; then',
  '      step "the Dopame dependencies not installed yet: $(echo $missing)"',
  '      pacman -S --needed --noconfirm $missing >/dev/null 2>&1 || for pkg in $missing; do',
  '        pacman -S --needed --noconfirm "$pkg" >/dev/null 2>&1 || step "warning: could not install $pkg"',
  '      done',
  '    fi',
  '  fi',
]
