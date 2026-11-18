import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export interface Host {
  readonly platform: NodeJS.Platform
  readonly arch: string
}

export const HOST: Host = { platform: process.platform, arch: process.arch }

export type Accel = 'kvm' | 'whpx' | 'hvf' | 'tcg'

export interface Qemu {
  readonly system: string
  readonly img: string
}

export const X86_64_V3 = ['avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe', 'xsave'] as const

export function preferredAccel(host: Host, kvmOpens: boolean): Accel {
  if (host.platform === 'linux') return kvmOpens ? 'kvm' : 'tcg'
  if (host.platform === 'win32') return 'whpx'
  if (host.platform === 'darwin') return 'hvf'
  return 'tcg'
}

export function accelArgs(accel: Accel): string[] {
  if (accel === 'kvm' || accel === 'hvf') return ['-accel', accel, '-cpu', 'host']
  if (accel === 'whpx') return ['-accel', 'whpx', '-cpu', 'max']
  return ['-accel', 'tcg,thread=multi', '-cpu', 'max']
}

export function exe(host: Host, name: string): string {
  return host.platform === 'win32' ? `${name}.exe` : name
}

function registryQemuDir(): string | null {
  const ran = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\QEMU', '/v', 'Install_Dir'], { encoding: 'utf8', windowsHide: true })
  const line = (ran.stdout ?? '').split(/\r?\n/).find((text) => /Install_Dir/i.test(text))
  return line?.split(/\s+REG_\w+\s+/)[1]?.trim() || null
}

export interface QemuSearch {
  readonly host: Host
  readonly env: NodeJS.ProcessEnv
  readonly exists?: (path: string) => boolean
  readonly registry?: () => string | null
}

export function qemuDirs(search: QemuSearch): string[] {
  const { host, env } = search
  const given = env['ACDEV_QEMU_DIR'] ? [env['ACDEV_QEMU_DIR']] : []
  const path = (env['PATH'] || env['Path'] || '').split(host.platform === 'win32' ? win32.delimiter : posix.delimiter).filter(Boolean)
  if (host.platform === 'win32') {
    const programFiles = env['ProgramFiles'] || 'C:\\Program Files'
    const registered = (search.registry ?? registryQemuDir)()
    return [...given, ...path, ...(registered ? [registered] : []), `${programFiles}\\qemu`, 'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin']
  }
  if (host.platform === 'darwin') return [...given, ...path, '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
  return [...given, ...path]
}

function paths(host: Host): typeof posix {
  return host.platform === 'win32' ? win32 : posix
}

function joinFor(host: Host, dir: string, name: string): string {
  return paths(host).join(dir, name)
}

export function findQemu(search: QemuSearch, guest: string): Qemu {
  const exists = search.exists ?? existsSync
  const system = exe(search.host, `qemu-system-${guest}`)
  const img = exe(search.host, 'qemu-img')
  const dirs = qemuDirs(search)
  const dir = dirs.find((candidate) => exists(joinFor(search.host, candidate, system)) && exists(joinFor(search.host, candidate, img)))
  if (dir === undefined) throw new Error(`vm: no ${system} and ${img} together in ${dirs.join(', ')}: ${installHint(search.host, guest)}`)
  return { system: joinFor(search.host, dir, system), img: joinFor(search.host, dir, img) }
}

function installHint(host: Host, guest: string): string {
  if (host.platform === 'win32') {
    return 'install QEMU from https://qemu.weilnetz.de/w64/ (or winget install SoftwareFreedomConservancy.QEMU), or set ACDEV_QEMU_DIR'
  }
  if (host.platform === 'darwin') return 'brew install qemu, or set ACDEV_QEMU_DIR'
  return `install ${guest === 'x86_64' ? 'qemu-system-x86' : 'qemu-system-arm'} and qemu-utils, or set ACDEV_QEMU_DIR`
}

export function bundledFirmware(host: Host, qemu: Qemu, guest: string): readonly [string, string] {
  const code = guest === 'aarch64' ? 'edk2-aarch64-code.fd' : 'edk2-x86_64-code.fd'
  const vars = guest === 'aarch64' ? 'edk2-arm-vars.fd' : 'edk2-i386-vars.fd'
  const bin = paths(host).dirname(qemu.system)
  const share = host.platform === 'win32' ? joinFor(host, bin, 'share') : posix.join(bin, '..', 'share', 'qemu')
  return [joinFor(host, share, code), joinFor(host, share, vars)]
}

export function missingFeatures(cpuinfo: string, wanted: readonly string[] = X86_64_V3): string[] {
  const flags = new Set((/^flags\s*:\s*(.*)$/m.exec(cpuinfo)?.[1] ?? '').split(/\s+/))
  return wanted.filter((flag) => !flags.has(flag))
}

export function spawnDetached(argv: readonly string[], log: number, env: NodeJS.ProcessEnv): { pid: number; exited: () => boolean } {
  const [file, ...args] = argv
  if (!file) throw new Error('nothing to run')
  const child = spawn(file, args, { detached: true, stdio: ['ignore', log, log], env, windowsHide: true })
  child.unref()
  return { pid: child.pid ?? 0, exited: () => child.exitCode !== null || child.signalCode !== null }
}
