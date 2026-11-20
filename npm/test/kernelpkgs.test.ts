import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL_SCRIPT, kernelPackage, kernelPackages } from '../src/vm/kernelpkgs.ts'
import { PROVISION_SCRIPT, provisionSources, stageProvision } from '../src/vm/provision.ts'

const NONE = { acdes: null, acdesBin: null, libacde: null, dopame: null, harness: null }
const WIFI = 'linux-ackernel-wifi-other-7.3.4-1-x86_64.pkg.tar.zst'
const GPU = 'linux-ackernel-gpu-other-7.3.4-1-x86_64.pkg.tar.zst'

describe('acdev vm provision --kernel-pkgs', () => {
  test('a group package file gives its name and pkgver-pkgrel; the kernel, its headers and the meta package are not groups', () => {
    expect(kernelPackage(WIFI)).toEqual({ file: WIFI, name: 'linux-ackernel-wifi-other', version: '7.3.4-1' })
    expect(kernelPackage('linux-ackernel-gpu-amd-7.3.4-2-aarch64.pkg.tar.zst')?.name).toBe('linux-ackernel-gpu-amd')
    for (const file of ['linux-ackernel-7.3.4-1-x86_64.pkg.tar.zst', 'linux-ackernel-headers-7.3.4-1-x86_64.pkg.tar.zst',
      'linux-ackernel-drivers-7.3.4-1-x86_64.pkg.tar.zst', 'linux-ackernel-wifi-other-7.3.4-1-x86_64.pkg.tar.zst.sig', 'README']) {
      expect(kernelPackage(file)).toBeNull()
    }
  })

  test('the directory needs group packages, all of one version', () => {
    expect(kernelPackages('d', [WIFI, GPU, 'linux-ackernel-7.3.4-1-x86_64.pkg.tar.zst']).version).toBe('7.3.4-1')
    expect(kernelPackages('d', [WIFI, GPU]).packages.map((p) => p.name)).toEqual(['linux-ackernel-wifi-other', 'linux-ackernel-gpu-other'])
    expect(() => kernelPackages('d', ['linux-ackernel-7.3.4-1-x86_64.pkg.tar.zst'])).toThrow('--kernel-pkgs d has no linux-ackernel-<group>')
    expect(() => kernelPackages('d', [WIFI, 'linux-ackernel-gpu-other-7.3.5-1-x86_64.pkg.tar.zst'])).toThrow('mixes linux-ackernel versions (7.3.4-1, 7.3.5-1)')
  })

  test('the flag is read, the packages and their version are staged, and nothing is staged without it', () => {
    expect(provisionSources(new Map([['kernel-pkgs', '/batch']])).kernelPkgs).toBe('/batch')
    expect(provisionSources(new Map()).kernelPkgs).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'acdev-kernel-'))
    for (const file of [WIFI, GPU, 'linux-ackernel-7.3.4-1-x86_64.pkg.tar.zst']) writeFileSync(join(dir, file), file)
    const given = stageProvision({ ...NONE, kernelPkgs: dir })
    const plain = stageProvision(NONE)
    try {
      expect(readFileSync(join(given, 'kernel', 'version'), 'utf8')).toBe('7.3.4-1\n')
      expect(existsSync(join(given, 'kernel', WIFI))).toBe(true)
      expect(existsSync(join(given, 'kernel', 'linux-ackernel-7.3.4-1-x86_64.pkg.tar.zst'))).toBe(false)
      expect(existsSync(join(plain, 'kernel'))).toBe(false)
    } finally {
      for (const path of [dir, given, plain]) rmSync(path, { recursive: true, force: true })
    }
    expect(() => stageProvision({ ...NONE, kernelPkgs: '/no/such/dir' })).toThrow('--kernel-pkgs /no/such/dir does not exist')
  })

  test('in the guest the version must be the running kernel package; only missing groups are installed, before the module checks', () => {
    const script = KERNEL_SCRIPT.join('\n')
    for (const line of ['want=$(cat "$here/kernel/version")', 'have=$(pacman -Q linux-ackernel 2>/dev/null | cut -d" " -f2)',
      'if [ "$want" != "$have" ]; then', 'exit 3', 'pacman -Q "$name" >/dev/null 2>&1 || wanted+=("$pkg")', 'pacman -U --needed --noconfirm']) {
      expect(script).toContain(line)
    }
    expect(PROVISION_SCRIPT).toContain(script)
    expect(PROVISION_SCRIPT.indexOf('want=$(cat "$here/kernel/version")')).toBeLessThan(PROVISION_SCRIPT.indexOf('restore bochs'))
  })
})
