import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GUEST_PASSWORD, GUEST_PASSWORD_ENV } from './guest.ts'

export interface ProvisionSources {
  readonly acdes: string | null
  readonly acdesBin: string | null
  readonly winmanBin: string | null
  readonly libacde: string | null
  readonly dopame: string | null
  readonly harness: string | null
}

export interface ProvisionOptions {
  readonly user: string
  readonly password: string
  readonly restart: boolean
}

export const PROVISION_DIR = '/opt/acdev/provision'

export const PROVISION_SCRIPT = [
  '#!/bin/bash',
  'set -euo pipefail',
  'here=$(cd "$(dirname "$0")" && pwd)',
  'user=$1 password=$2 restart=$3',
  'step() { echo "acdev provision: $*"; }',
  '',
  'step "the package database"',
  'pacman -Sy --noconfirm >/dev/null || step "pacman -Sy failed (no network?): installing from what is there"',
  'for pkg in greetd xdg-user-dirs; do',
  '  pacman -Q "$pkg" >/dev/null 2>&1 || pacman -S --noconfirm --needed "$pkg" >/dev/null',
  'done',
  '',
  'if [ -f "$here/acdes/PKGBUILD" ]; then',
  '  step "acdes, laid out by its own PKGBUILD package()"',
  '  (',
  '    set +u',
  '    srcdir="$here/acdes/src" pkgdir=""',
  '    . "$here/acdes/PKGBUILD"',
  '    package',
  '  )',
  '  ln -sf acdes /usr/bin/acdert',
  '  systemd-tmpfiles --create /usr/lib/tmpfiles.d/acde.conf',
  'fi',
  '[ -x /usr/bin/acdes ] || { echo "acdev provision: /usr/bin/acdes is missing: give --acdes the first time" >&2; exit 3; }',
  '',
  'if [ -d "$here/dopame" ]; then',
  '  step "the Dopame desktop package"',
  '  dir=/usr/share/acde/packages/dopame',
  '  mkdir -p "$dir"',
  '  for f in package.json mcp.json; do if [ -f "$here/dopame/$f" ]; then install -Dm644 "$here/dopame/$f" "$dir/$f"; fi; done',
  '  if [ -d "$here/dopame/dist" ]; then rm -rf "$dir/dist"; cp -a "$here/dopame/dist" "$dir/dist"; fi',
  '  if [ -f "$here/dopame/dopame-harness" ]; then install -Dm755 "$here/dopame/dopame-harness" /usr/lib/dopame/dopame-harness; fi',
  '  if [ -f "$here/dopame/dopame-board.service" ]; then install -Dm644 "$here/dopame/dopame-board.service" /usr/lib/systemd/user/; fi',
  'fi',
  '',
  'step "the user $user"',
  'if ! id "$user" >/dev/null 2>&1; then',
  '  groups=$(for g in video input audio render seat; do if getent group "$g" >/dev/null; then printf \'%s,\' "$g"; fi; done)',
  '  if [ -n "$groups" ]; then useradd -m -G "$(printf %s "$groups" | sed \'s/,$//\')" "$user"; else useradd -m "$user"; fi',
  'fi',
  'printf \'%s:%s\\n\' "$user" "$password" | chpasswd',
  'faillock --user "$user" --reset 2>/dev/null || true',
  'su - "$user" -c xdg-user-dirs-update >/dev/null 2>&1 || true',
  '',
  'step "greetd runs the acdes login screen"',
  'mkdir -p /etc/greetd',
  'cat >/etc/greetd/config.toml <<\'EOF\'',
  '[terminal]',
  'vt = 1',
  '',
  '[default_session]',
  'command = "/usr/bin/acdes --greeter"',
  'user = "greeter"',
  'EOF',
  'systemctl enable greetd >/dev/null 2>&1 || true',
  'if [ "$restart" = 1 ]; then',
  '  step "restarting greetd"',
  '  systemctl restart greetd',
  'fi',
  'step "done: log in as $user"',
  '',
].join('\n')

function need(path: string, what: string): string {
  const full = resolve(path)
  if (!existsSync(full)) throw new Error(`vm provision: ${what} ${path} does not exist`)
  return full
}

function stageAcdes(stage: string, sources: ProvisionSources): void {
  if (!sources.acdes) {
    if (sources.acdesBin || sources.winmanBin) throw new Error('vm provision: --acdes-bin and --winman-bin need --acdes (the acdes checkout, for its PKGBUILD)')
    return
  }
  if (!sources.acdesBin || !sources.winmanBin) throw new Error('vm provision: --acdes needs --acdes-bin and --winman-bin (the guest builds)')
  const repo = need(sources.acdes, '--acdes')
  const src = join(stage, 'acdes', 'src')
  cpSync(need(join(repo, 'packaging', 'arch', 'PKGBUILD'), 'the acdes PKGBUILD'), join(stage, 'acdes', 'PKGBUILD'))
  cpSync(join(repo, 'packaging'), join(src, 'acdebin-system', 'packaging'), { recursive: true })
  mkdirSync(join(src, 'target', 'release'), { recursive: true })
  mkdirSync(join(src, 'target-winman', 'release'), { recursive: true })
  cpSync(need(sources.acdesBin, '--acdes-bin'), join(src, 'target', 'release', 'acdes'))
  cpSync(need(sources.winmanBin, '--winman-bin'), join(src, 'target-winman', 'release', 'winman'))
  const license = sources.libacde ? join(resolve(sources.libacde), 'LICENSE') : null
  mkdirSync(join(src, 'libacde'), { recursive: true })
  if (license && existsSync(license)) cpSync(license, join(src, 'libacde', 'LICENSE'))
  else writeFileSync(join(src, 'libacde', 'LICENSE'), '')
}

function stageDopame(stage: string, sources: ProvisionSources): void {
  if (!sources.dopame && !sources.harness) return
  const out = join(stage, 'dopame')
  mkdirSync(out, { recursive: true })
  if (sources.dopame) {
    const repo = need(sources.dopame, '--dopame')
    const pkg = join(repo, 'packages', 'dopame')
    for (const file of ['package.json', 'mcp.json']) if (existsSync(join(pkg, file))) cpSync(join(pkg, file), join(out, file))
    cpSync(need(join(pkg, 'dist'), 'the Dopame build (bun scripts/build.ts)'), join(out, 'dist'), { recursive: true })
    const board = join(repo, 'packaging', 'arch', 'dopame-board.service')
    if (existsSync(board)) cpSync(board, join(out, 'dopame-board.service'))
  }
  if (sources.harness) cpSync(need(sources.harness, '--harness'), join(out, 'dopame-harness'))
}

export function stageProvision(sources: ProvisionSources): string {
  const stage = mkdtempSync(join(tmpdir(), 'acdev-provision-'))
  try {
    stageAcdes(stage, sources)
    stageDopame(stage, sources)
    writeFileSync(join(stage, 'provision.sh'), PROVISION_SCRIPT, { mode: 0o755 })
    return stage
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

export function provisionOptions(flags: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv = process.env): ProvisionOptions {
  return { user: flags.get('user') ?? 'tester', password: env[GUEST_PASSWORD_ENV] || GUEST_PASSWORD, restart: !flags.has('no-restart') }
}

export function provisionSources(flags: ReadonlyMap<string, string>): ProvisionSources {
  const get = (name: string) => flags.get(name) ?? null
  return {
    acdes: get('acdes'), acdesBin: get('acdes-bin'), winmanBin: get('winman-bin'), libacde: get('libacde'), dopame: get('dopame'), harness: get('harness'),
  }
}
