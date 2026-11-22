import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { GUEST_PASSWORD, GUEST_PASSWORD_ENV } from './guest.ts'
import { GUEST_HARDWARE, hardwareFiles, type GuestHardware } from './guesthw.ts'
import { KERNEL_SCRIPT, PKGS_SCRIPT, stageKernel, stagePkgs } from './kernelpkgs.ts'
import { BACKEND_SCRIPT, DEPENDS_SCRIPT, DROPIN_SCRIPT, stageBackend, stageDepends, stageDropIns } from './dopamebackend.ts'

export interface ProvisionSources {
  readonly acdes: string | null
  readonly acdesBin: string | null
  readonly libacde: string | null
  readonly dopame: string | null
  readonly harness: string | null
  readonly kernelPkgs?: string | null
  readonly pkgs?: string | null
  readonly systemAgentBin?: string | null
  readonly managerNode?: string | null
  readonly proxyBin?: string | null
}

const ACDES_BUILDS = [
  { file: 'system-agent', source: 'systemAgentBin', flag: '--system-agent-bin', build: 'cargo build -p acde-system-agent' },
  { file: 'libacdes_manager_node.so', source: 'managerNode', flag: '--manager-node', build: 'cargo build -p acdes-manager-node' },
  { file: 'proxy', source: 'proxyBin', flag: '--proxy-bin', build: 'cargo build -p acde-proxy' },
] as const

export interface ProvisionOptions {
  readonly user: string
  readonly password: string
  readonly restart: boolean
}

export const PROVISION_DIR = '/opt/acdev/provision'

export const ACDES_SERVICES = ['acdes-system-agent', 'acdes-proxy'] as const

export const DEV_SUDOERS = '/etc/sudoers.d/acdev-dev'

export const PRUNED = {
  bochs: { module: 'bochs', package: 'linux-ackernel-gpu-other' },
  hwsim: { module: 'mac80211_hwsim', package: 'linux-ackernel-wifi-other' },
} as const

export const PROVISION_SCRIPT = [
  '#!/bin/bash',
  'set -euo pipefail',
  'here=$(cd "$(dirname "$0")" && pwd)',
  'user=$1 password=$2 restart=$3',
  'step() { echo "acdev provision: $*"; }',
  'warned="$here/warnings"',
  ': >"$warned"',
  'warn() { echo "acdev provision: warning: $*" >&2; echo "$*" >>"$warned"; }',
  '',
  'step "the package database"',
  'synced=0',
  'for try in 1 2 3; do',
  '  if pacman -Sy --noconfirm >/dev/null; then synced=1; break; fi',
  '  step "pacman -Sy failed (try $try of 3)"; sleep 5',
  'done',
  '[ "$synced" = 1 ] || warn "pacman -Sy kept failing (no network?): installing from what is there"',
  'for pkg in greetd xdg-user-dirs fcitx5 fcitx5-rime rime-pinyin-simp foot xdg-desktop-portal-gtk; do',
  '  pacman -Q "$pkg" >/dev/null 2>&1 || pacman -S --noconfirm --needed "$pkg" >/dev/null || warn "could not install $pkg"',
  'done',
  'pacman -Q greetd >/dev/null 2>&1 || { echo "acdev provision: greetd is not installed" >&2; exit 3; }',
  '',
  ...KERNEL_SCRIPT,
  ...PKGS_SCRIPT,
  'restore() {',
  '  modinfo "$1" >/dev/null 2>&1 && return 0',
  '  step "the $1 module is missing (agentos-drivers prune removes $2): installing $2 back"',
  '  pacman -S --needed --noconfirm "$2" >/dev/null || { warn "could not install $2"; return 0; }',
  '  modinfo "$1" >/dev/null 2>&1 || depmod -a || true',
  '  modinfo "$1" >/dev/null 2>&1 || warn "$2 is installed but there is still no $1 module"',
  '}',
  `restore ${PRUNED.bochs.module} ${PRUNED.bochs.package}`,
  '',
  'if [ -f "$here/acdes/PKGBUILD" ]; then',
  '  step "acdes, laid out by its own PKGBUILD package()"',
  '  rm -f /usr/bin/acdert',
  '  (',
  '    set +u',
  '    srcdir="$here/acdes/src" pkgdir=""',
  '    unset CARGO_TARGET_DIR',
  '    . "$here/acdes/PKGBUILD"',
  `    missing=$(pacman -T "\${depends[@]}" || true)`,
  '    if [ -n "$missing" ]; then',
  '      step "the acdes dependencies not installed yet: $(echo $missing)"',
  '      pacman -S --needed --noconfirm $missing >/dev/null || warn "could not install all of: $(echo $missing)"',
  '    fi',
  '    package',
  '  )',
  '  ln -sf acdes /usr/bin/acdert',
  '  systemd-sysusers',
  '  for conf in /usr/lib/tmpfiles.d/acde*.conf; do',
  '    [ ! -f "$conf" ] || systemd-tmpfiles --create "$conf"',
  '  done',
  '  chown -R greeter:greeter /var/lib/acde/greeter',
  '  glib-compile-schemas /usr/share/glib-2.0/schemas 2>/dev/null || true',
  'fi',
  '[ -x /usr/bin/acdes ] || { echo "acdev provision: /usr/bin/acdes is missing: give --pkgs (an acdes package) or --acdes the first time" >&2; exit 3; }',
  'systemctl daemon-reload',
  `for unit in ${ACDES_SERVICES.join(' ')}; do`,
  '  [ -f "/usr/lib/systemd/system/$unit.service" ] || continue',
  '  step "$unit (the acdes package leaves it off for the OS to turn on)"',
  '  systemctl enable "$unit" >/dev/null 2>&1 || warn "could not enable $unit"',
  '  systemctl restart "$unit" || warn "$unit did not start"',
  'done',
  '',
  'if [ -d "$here/dopame" ]; then',
  ...DEPENDS_SCRIPT,
  '  step "the Dopame desktop package"',
  '  dir=/usr/share/acde/packages/dopame',
  '  mkdir -p "$dir"',
  '  for f in package.json mcp.json; do if [ -f "$here/dopame/$f" ]; then install -Dm644 "$here/dopame/$f" "$dir/$f"; fi; done',
  '  if [ -d "$here/dopame/dist" ]; then rm -rf "$dir/dist"; cp -a "$here/dopame/dist" "$dir/dist"; fi',
  '  if [ -f "$here/dopame/dopame-harness" ]; then install -Dm755 "$here/dopame/dopame-harness" /usr/lib/dopame/dopame-harness; fi',
  '  if [ -f "$here/dopame/dopame-board.service" ]; then install -Dm644 "$here/dopame/dopame-board.service" /usr/lib/systemd/user/; fi',
  ...BACKEND_SCRIPT,
  ...DROPIN_SCRIPT,
  'fi',
  '',
  'step "the user $user"',
  'if ! id "$user" >/dev/null 2>&1; then',
  '  groups=$(for g in wheel video input audio render seat; do if getent group "$g" >/dev/null; then printf \'%s,\' "$g"; fi; done)',
  '  if [ -n "$groups" ]; then useradd -m -G "$(printf %s "$groups" | sed \'s/,$//\')" "$user"; else useradd -m "$user"; fi',
  'fi',
  'printf \'%s:%s\\n\' "$user" "$password" | chpasswd',
  'faillock --user "$user" --reset 2>/dev/null || true',
  'su - "$user" -c \'LC_ALL=C.UTF-8 xdg-user-dirs-update --force\' >/dev/null 2>&1 || true',
  '',
  'step "sudo rules for $user: the dopame guest checks swap the environment of its session agent unit"',
  `rules=${DEV_SUDOERS}`,
  'if [ -d /etc/sudoers.d ] && command -v visudo >/dev/null; then',
  '  uid=$(id -u "$user")',
  '  dir="/run/systemd/system/acdes-session-agent@$uid.service.d"',
  '  conf="$dir/zz-dopame-check.conf"',
  '  cmds="/usr/bin/install -D -m 644 * $conf, /usr/bin/rm -f $conf, /usr/bin/rmdir --ignore-fail-on-non-empty $dir"',
  '  cmds="$cmds, /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart acdes-session-agent@$uid.service"',
  '  printf \'%s ALL=(root) NOPASSWD: %s\\n\' "$user" "$cmds" >"$rules.tmp"',
  '  chown root:root "$rules.tmp" && chmod 0440 "$rules.tmp"',
  '  if visudo -cf "$rules.tmp" >/dev/null; then',
  '    mv -f "$rules.tmp" "$rules"',
  '  else',
  '    rm -f "$rules.tmp" "$rules"',
  '    warn "visudo rejected the sudo rules for $user, so there is no $rules"',
  '  fi',
  'else',
  '  warn "no sudo in the guest (/etc/sudoers.d, visudo), so there is no $rules"',
  'fi',
  '',
  'if [ -d "$here/hw" ]; then',
  '  step "simulated hardware: packages, scripts in /usr/local/bin, units in /etc/systemd/system"',
  `  if [ -f "$here/hw/units/acdev-wifi.service" ]; then restore ${PRUNED.hwsim.module} ${PRUNED.hwsim.package}; fi`,
  '  while read -r pkg; do',
  '    [ -n "$pkg" ] || continue',
  '    pacman -Q "$pkg" >/dev/null 2>&1 || pacman -S --noconfirm --needed "$pkg" >/dev/null || warn "could not install $pkg"',
  '  done <"$here/hw/packages"',
  '  for script in "$here"/hw/acdev-*; do',
  '    if [ -f "$script" ]; then install -Dm755 "$script" "/usr/local/bin/$(basename "$script")"; fi',
  '  done',
  '  if [ -f "$here/hw/btvirt" ]; then install -Dm755 "$here/hw/btvirt" /usr/local/bin/btvirt; fi',
  '  if [ -f "$here/hw/acdev-btvirt-build" ] && ! command -v btvirt >/dev/null; then',
  '    step "btvirt (no Arch package has it): building emulator/btvirt from the source of the installed bluez"',
  '    /usr/local/bin/acdev-btvirt-build || warn "no btvirt, so the simulated Bluetooth stays off"',
  '  fi',
  '  while read -r unit; do',
  '    [ -n "$unit" ] || continue',
  '    systemctl disable --now "$unit" >/dev/null 2>&1 || true',
  '    rm -f "/etc/systemd/system/$unit"',
  '    step "$unit is off"',
  '  done <"$here/hw/off"',
  '  for unit in "$here"/hw/units/*.service; do',
  '    if [ -f "$unit" ]; then install -Dm644 "$unit" "/etc/systemd/system/$(basename "$unit")"; fi',
  '  done',
  '  systemctl daemon-reload',
  '  for unit in "$here"/hw/units/*.service; do',
  '    [ -f "$unit" ] || continue',
  '    name=$(basename "$unit")',
  '    systemctl enable "$name" >/dev/null 2>&1 || warn "could not enable $name"',
  '    systemctl restart "$name" || warn "$name did not start"',
  '    journalctl -u "$name" -n 2 --no-pager -o cat 2>/dev/null | grep "^acdev-" | sed "s/^/acdev provision: /" || true',
  '  done',
  'fi',
  '',
  'step "greetd runs the acdes login screen"',
  'for g in video input; do if getent group "$g" >/dev/null; then usermod -aG "$g" greeter; fi; done',
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
  'if [ -s "$warned" ]; then',
  '  echo "acdev provision: done with $(wc -l <"$warned") warning(s), so it exits 4:" >&2',
  '  sed "s/^/acdev provision:   /" "$warned" >&2',
  '  exit 4',
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
    if (sources.acdesBin) throw new Error('vm provision: --acdes-bin needs --acdes (the acdes checkout, for its PKGBUILD)')
    return
  }
  if (!sources.acdesBin) throw new Error('vm provision: --acdes needs --acdes-bin (the guest build)')
  const repo = need(sources.acdes, '--acdes')
  const src = join(stage, 'acdes', 'src')
  cpSync(need(join(repo, 'packaging', 'arch', 'PKGBUILD'), 'the acdes PKGBUILD'), join(stage, 'acdes', 'PKGBUILD'))
  cpSync(join(repo, 'packaging'), join(src, 'acdes', 'packaging'), { recursive: true })
  for (const path of pkgbuildPaths(readFileSync(join(stage, 'acdes', 'PKGBUILD'), 'utf8'))) {
    cpSync(need(join(repo, path), 'what the acdes PKGBUILD installs,'), join(src, 'acdes', path), { recursive: true })
  }
  mkdirSync(join(src, 'target', 'release'), { recursive: true })
  cpSync(need(sources.acdesBin, '--acdes-bin'), join(src, 'target', 'release', 'acdes'))
  const pkgbuild = readFileSync(join(stage, 'acdes', 'PKGBUILD'), 'utf8')
  for (const { file, source, flag, build } of ACDES_BUILDS) {
    const given = sources[source]
    if (given) cpSync(need(given, flag), join(src, 'target', 'release', file))
    else if (pkgbuild.includes(`release/${file}`)) throw new Error(`vm provision: this acdes PKGBUILD installs ${file}: give ${flag} (${build})`)
  }
  const license = sources.libacde ? join(resolve(sources.libacde), 'LICENSE') : null
  mkdirSync(join(src, 'libacde'), { recursive: true })
  if (license && existsSync(license)) cpSync(license, join(src, 'libacde', 'LICENSE'))
  else writeFileSync(join(src, 'libacde', 'LICENSE'), '')
}

export function pkgbuildPaths(pkgbuild: string): string[] {
  const used = [...pkgbuild.matchAll(/\$\{?srcdir\}?\/acdes\/([A-Za-z0-9._@/*-]+)/g)].map(([, path]) => path!)
  const plain = used.map((path) => (path.includes('*') ? path.slice(0, path.indexOf('*')).replace(/[^/]*$/, '') : path).replace(/\/+$/, ''))
  return [...new Set(plain.filter((path) => path !== '' && !path.split('/').includes('..')))]
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
    stageBackend(repo, out)
    stageDropIns(repo, out)
    stageDepends(repo, out)
  }
  if (sources.harness) cpSync(need(sources.harness, '--harness'), join(out, 'dopame-harness'))
}

export interface HardwareChoice {
  readonly on: readonly GuestHardware[]
  readonly off: readonly GuestHardware[]
  readonly btvirt?: string | null
}

function stageHardware(stage: string, { on, off, btvirt }: HardwareChoice): void {
  const dir = join(stage, 'hw')
  const { scripts, units, packages, off: stopped } = hardwareFiles(on, off)
  mkdirSync(join(dir, 'units'), { recursive: true })
  writeFileSync(join(dir, 'off'), stopped.map((unit) => `${unit}\n`).join(''))
  for (const [name, text] of Object.entries(units)) writeFileSync(join(dir, 'units', name), text)
  writeFileSync(join(dir, 'packages'), packages.map((pkg) => `${pkg}\n`).join(''))
  for (const [name, text] of Object.entries(scripts)) writeFileSync(join(dir, name), text, { mode: 0o755 })
  if (btvirt && on.includes('bluetooth')) cpSync(need(btvirt, '--btvirt'), join(dir, 'btvirt'))
}

export function stageProvision(sources: ProvisionSources, hardware: HardwareChoice = { on: GUEST_HARDWARE, off: [] }): string {
  const stage = mkdtempSync(join(tmpdir(), 'acdev-provision-'))
  try {
    stageAcdes(stage, sources)
    stageDopame(stage, sources)
    stageHardware(stage, hardware)
    if (sources.kernelPkgs) stageKernel(stage, sources.kernelPkgs)
    if (sources.pkgs) stagePkgs(stage, sources.pkgs)
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
    acdes: get('acdes'), acdesBin: get('acdes-bin'), libacde: get('libacde'), dopame: get('dopame'), harness: get('harness'),
    kernelPkgs: get('kernel-pkgs'), pkgs: get('pkgs'), systemAgentBin: get('system-agent-bin'), managerNode: get('manager-node'),
    proxyBin: get('proxy-bin'),
  }
}
