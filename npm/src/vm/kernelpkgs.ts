import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface KernelPackage {
  readonly file: string
  readonly name: string
  readonly version: string
}

export interface KernelPackages {
  readonly version: string
  readonly packages: readonly KernelPackage[]
}

const BASE = 'linux-ackernel'
const NOT_GROUPS: ReadonlySet<string> = new Set([BASE, `${BASE}-headers`, `${BASE}-drivers`])
const FETCH = 'take the stable/<number>/ batch of the ackernel CI that built the guest kernel'

export function kernelPackage(file: string): KernelPackage | null {
  const parts = /^(.+)-([^-]+)-([^-]+)-([^-]+)\.pkg\.tar\.zst$/.exec(file)
  if (!parts) return null
  const [, name, pkgver, pkgrel] = parts as unknown as [string, string, string, string]
  if (!name.startsWith(`${BASE}-`) || NOT_GROUPS.has(name)) return null
  return { file, name, version: `${pkgver}-${pkgrel}` }
}

export function kernelPackages(dir: string, files: readonly string[]): KernelPackages {
  const packages = files.map(kernelPackage).filter((pkg): pkg is KernelPackage => pkg !== null)
  if (!packages.length) throw new Error(`vm provision: --kernel-pkgs ${dir} has no ${BASE}-<group>-*.pkg.tar.zst: ${FETCH}`)
  const versions = [...new Set(packages.map((pkg) => pkg.version))]
  if (versions.length > 1) throw new Error(`vm provision: --kernel-pkgs ${dir} mixes ${BASE} versions (${versions.join(', ')}): ${FETCH}`)
  return { version: versions[0]!, packages }
}

export function stageKernel(stage: string, dir: string): KernelPackages {
  const from = resolve(dir)
  if (!existsSync(from)) throw new Error(`vm provision: --kernel-pkgs ${dir} does not exist`)
  const found = kernelPackages(dir, readdirSync(from))
  const out = join(stage, 'kernel')
  mkdirSync(out, { recursive: true })
  for (const { file } of found.packages) cpSync(join(from, file), join(out, file))
  writeFileSync(join(out, 'version'), `${found.version}\n`)
  return found
}

export const LEGACY_PACKAGES = ['acdebin-system', 'acde-dopame'] as const

export function stagePkgs(stage: string, dir: string): string[] {
  const from = resolve(dir)
  if (!existsSync(from)) throw new Error(`vm provision: --pkgs ${dir} does not exist`)
  const files = readdirSync(from).filter((file) => file.endsWith('.pkg.tar.zst'))
  if (!files.length) throw new Error(`vm provision: --pkgs ${dir} has no *.pkg.tar.zst`)
  const out = join(stage, 'pkgs')
  mkdirSync(out, { recursive: true })
  for (const file of files) cpSync(join(from, file), join(out, file))
  return files
}

export const PKGS_SCRIPT = [
  'if [ -d "$here/pkgs" ]; then',
  `  for old in ${LEGACY_PACKAGES.join(' ')}; do`,
  '    [ "$(pacman -Qq "$old" 2>/dev/null)" = "$old" ] || continue',
  '    step "removing $old (replaced by acdes and dopame)"',
  '    pacman -Rdd --noconfirm "$old" >/dev/null',
  '  done',
  '  step "the packages from --pkgs: $(cd "$here/pkgs" && echo *.pkg.tar.zst)"',
  '  pacman -U --noconfirm "$here"/pkgs/*.pkg.tar.zst >/dev/null || { echo "acdev provision: pacman -U of the --pkgs packages failed (see pacman above)" >&2; exit 3; }',
  'fi',
  '',
]

export const KERNEL_SCRIPT = [
  'if [ -d "$here/kernel" ]; then',
  '  want=$(cat "$here/kernel/version")',
  `  have=$(pacman -Q ${BASE} 2>/dev/null | cut -d" " -f2)`,
  '  [ -n "$have" ] || have="(not installed)"',
  '  if [ "$want" != "$have" ]; then',
  `    echo "acdev provision: the --kernel-pkgs packages are ${BASE} $want, the guest runs ${BASE} $have: take the CI batch built as $have" >&2`,
  '    exit 3',
  '  fi',
  '  wanted=()',
  '  for pkg in "$here"/kernel/*.pkg.tar.zst; do',
  '    name=$(pacman -Qqp "$pkg")',
  '    pacman -Q "$name" >/dev/null 2>&1 || wanted+=("$pkg")',
  '  done',
  `  if [ "\${#wanted[@]}" -gt 0 ]; then`,
  `    step "the kernel module packages from --kernel-pkgs: $(for p in "\${wanted[@]}"; do basename "$p"; done | tr "\\n" " ")"`,
  `    pacman -U --needed --noconfirm "\${wanted[@]}" >/dev/null || { echo "acdev provision: pacman -U of the --kernel-pkgs packages failed" >&2; exit 3; }`,
  '  else',
  '    step "--kernel-pkgs: every module package in it is installed already"',
  '  fi',
  'fi',
  '',
]
