import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CrateBinary } from '../binary.ts'
import { GUEST_HARDWARE, HW_DIR, hardwareFiles } from '../guesthw.ts'

export const TOOLS = 'acdev-guest-tools'

export const AGENT: CrateBinary = { crate: 'agent', name: 'acdev-agent', variable: 'ACDEV_AGENT', shared: 'rust' }

export const DEV_SUDOERS = '/etc/sudoers.d/acdev-dev'

export const SUDO_SCRIPT = 'acdev-dev-sudo'

export const LEGACY = [
  '/usr/local/bin/acdevd', '/etc/systemd/system/acdevd.service',
  ...Object.keys(hardwareFiles(GUEST_HARDWARE).scripts).map((script) => `/usr/local/bin/${script}`),
  ...Object.keys(hardwareFiles(GUEST_HARDWARE).units).map((unit) => `/etc/systemd/system/${unit}`),
] as const

export interface ToolBinaries {
  readonly devd: string
  readonly agent: string | null
}

export interface ToolsBuild {
  readonly version: string
  readonly arch: string
  readonly builddate: number
}

export function devdUnit(exec: string): string {
  return `[Unit]
Description=acdev device daemon (vsock, or TCP with the key from fw_cfg)
After=local-fs.target network.target

[Service]
ExecStartPre=-/usr/bin/modprobe qemu_fw_cfg
ExecStart=${exec} serve
Restart=always

[Install]
WantedBy=multi-user.target
`
}

export const AGENT_UNIT = `[Unit]
Description=acdev's agent: the dev socket over the session manager's dev hooks
ConditionPathExists=/sys/firmware/qemu_fw_cfg/by_name/opt/acdev/key/raw
After=systemd-logind.service acdevd.service

[Service]
ExecStartPre=-/usr/bin/modprobe qemu_fw_cfg
ExecStart=/usr/bin/acdev-agent serve
Restart=always
RestartSec=1
SyslogIdentifier=acdev-agent

[Install]
WantedBy=multi-user.target
`

const SUDO = [
  '#!/bin/bash',
  'set -euo pipefail',
  'user=$1',
  `rules=${DEV_SUDOERS}`,
  'if [ ! -d /etc/sudoers.d ] || ! command -v visudo >/dev/null; then',
  '  echo "no sudo in the guest (/etc/sudoers.d, visudo), so there is no $rules" >&2',
  '  exit 3',
  'fi',
  'uid=$(id -u "$user")',
  'dir="/run/systemd/system/acdes-session-agent@$uid.service.d"',
  'conf="$dir/zz-dopame-check.conf"',
  'cmds="/usr/bin/install -D -m 644 * $conf, /usr/bin/rm -f $conf, /usr/bin/rmdir --ignore-fail-on-non-empty $dir"',
  'cmds="$cmds, /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart acdes-session-agent@$uid.service"',
  'printf \'%s ALL=(root) NOPASSWD: %s\\n\' "$user" "$cmds" >"$rules.tmp"',
  'chown root:root "$rules.tmp" && chmod 0440 "$rules.tmp"',
  'if ! visudo -cf "$rules.tmp" >/dev/null; then',
  '  rm -f "$rules.tmp" "$rules"',
  '  echo "visudo rejected the sudo rules for $user, so there is no $rules" >&2',
  '  exit 3',
  'fi',
  'mv -f "$rules.tmp" "$rules"',
  '',
].join('\n')

export const TOOLS_SCRIPT = [
  `step "${TOOLS} $(cat "$here/tools/version"): acdevd, acdev-agent, the simulated hardware, the test sudo rules"`,
  `had=$(pacman -Q ${TOOLS} 2>/dev/null | cut -d" " -f2 || true)`,
  'if [ -n "$had" ] && [ "$had" != "$(cat "$here/tools/version")-1" ]; then step "it replaces $had"; fi',
  `for old in ${LEGACY.join(' ')}; do`,
  '  if [ -e "$old" ]; then rm -f "$old"; step "$old (laid out before the package) is gone"; fi',
  'done',
  `(cd "$here/tools/root" && bsdtar -cf "$here/tools/${TOOLS}.pkg.tar" .PKGINFO usr)`,
  `if pacman -U --noconfirm --overwrite '*' "$here/tools/${TOOLS}.pkg.tar" >/dev/null; then`,
  '  systemctl daemon-reload',
  '  systemctl enable acdevd >/dev/null 2>&1 || warn "could not enable acdevd"',
  '  if [ -x /usr/bin/acdev-agent ]; then',
  '    systemctl enable acdev-agent >/dev/null 2>&1 || warn "could not enable acdev-agent"',
  '    systemctl restart acdev-agent || warn "acdev-agent did not start"',
  '  else',
  `    note "this ${TOOLS} has no acdev-agent, so the host reaches the session through the manager's dev.sock"`,
  '  fi',
  'else',
  `  warn "could not install ${TOOLS}"`,
  'fi',
] as const

function put(root: string, path: string, data: string | Buffer, mode: number): number {
  const to = join(root, path)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, data, { mode })
  return typeof data === 'string' ? Buffer.byteLength(data) : data.length
}

export function pkgver(version: string): string {
  return version.replace(/[^A-Za-z0-9._+]/g, '_')
}

export function pkginfo({ version, arch, builddate }: ToolsBuild, size: number): string {
  return [
    `pkgname = ${TOOLS}`,
    `pkgbase = ${TOOLS}`,
    `pkgver = ${pkgver(version)}-1`,
    'pkgdesc = acdev\'s tools in the guests it starts: acdevd, acdev-agent, the simulated hardware, the test sudo rules',
    'url = http://gitea.dopamine/AC/acdev',
    `builddate = ${builddate}`,
    'packager = acdev',
    `size = ${size}`,
    `arch = ${arch}`,
    'license = LicenseRef-acdev',
    '',
  ].join('\n')
}

export function stageTools(stage: string, binaries: ToolBinaries, build: ToolsBuild): void {
  const root = join(stage, 'tools', 'root')
  let size = put(root, 'usr/bin/acdevd', readFileSync(binaries.devd), 0o755)
  size += put(root, 'usr/lib/systemd/system/acdevd.service', devdUnit('/usr/bin/acdevd'), 0o644)
  if (binaries.agent) {
    size += put(root, 'usr/bin/acdev-agent', readFileSync(binaries.agent), 0o755)
    size += put(root, 'usr/lib/systemd/system/acdev-agent.service', AGENT_UNIT, 0o644)
  }
  const { scripts, units } = hardwareFiles(GUEST_HARDWARE)
  for (const [name, text] of Object.entries(scripts)) size += put(root, `${HW_DIR.slice(1)}/${name}`, text, 0o755)
  for (const [name, text] of Object.entries(units)) size += put(root, `usr/lib/systemd/system/${name}`, text, 0o644)
  size += put(root, `${HW_DIR.slice(1)}/${SUDO_SCRIPT}`, SUDO, 0o755)
  writeFileSync(join(root, '.PKGINFO'), pkginfo(build, size))
  writeFileSync(join(stage, 'tools', 'version'), `${pkgver(build.version)}\n`)
}
