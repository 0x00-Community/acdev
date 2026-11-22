import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { GuestAgent } from '../channel.ts'
import { accelArgs, preferredAccel, spawnDetached, type Accel } from '../host.ts'
import type { Machine } from '../machine.ts'

export const ACINSTALL = {
  probe: 'acinstall probe',
  install: 'acinstall install',
  status: '/run/acinstaller/status.json',
  log: '/run/acinstaller/install.log',
  plan: '/run/acinstaller-plan.json',
} as const

export type Say = (line: string) => void

export interface ProbeDisk {
  readonly path: string
  readonly busy: boolean
  readonly partitions: readonly unknown[]
}

export interface InstallStatus {
  readonly state: string
  readonly step: number
  readonly steps: number
  readonly name: string | null
}

export class InstallerChanged extends Error {}

const STAMP = /(\d{8}T\d{6}Z)/

export function stamp(name: string): string | null {
  return STAMP.exec(name)?.[1] ?? null
}

export function isoIsNewer(iso: string, qcow2: string): boolean {
  const [a, b] = [stamp(iso), stamp(qcow2)]
  return a !== null && (b === null || a > b)
}

export function emptyDisk(probe: string): string {
  let parsed: { disks?: unknown }
  try {
    parsed = JSON.parse(probe) as { disks?: unknown }
  } catch {
    throw new InstallerChanged(`${ACINSTALL.probe} did not answer JSON: ${probe.slice(0, 200)}`)
  }
  if (!Array.isArray(parsed.disks)) throw new InstallerChanged(`${ACINSTALL.probe} has no disks list`)
  const disks = parsed.disks as Partial<ProbeDisk>[]
  if (disks.some((d) => typeof d.path !== 'string' || typeof d.busy !== 'boolean' || !Array.isArray(d.partitions))) {
    throw new InstallerChanged(`${ACINSTALL.probe}: a disk without path, busy or partitions`)
  }
  const empty = disks.filter((d) => !d.busy && d.partitions!.length === 0).map((d) => d.path as string)
  if (empty.length !== 1) throw new Error(`vm: not one empty disk in the installer's view: ${empty.join(', ') || 'none'}`)
  return empty[0]!
}

export function installPlan(disk: string, password: string): string {
  return JSON.stringify({
    where: { mode: 'disk', disk }, user: 'dopame', fullName: 'dopame', password, host: 'dopame',
    timezone: 'Asia/Shanghai', locale: 'zh_CN.UTF-8', sudoNoPassword: false, portable: true,
  })
}

export function installStatus(text: string): InstallStatus | null {
  if (!text.trim()) return null
  let parsed: { state?: unknown; step?: unknown; steps?: unknown }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return null
  }
  if (typeof parsed.state !== 'string') throw new InstallerChanged(`${ACINSTALL.status} has no state`)
  const steps = Array.isArray(parsed.steps) ? parsed.steps : []
  const step = typeof parsed.step === 'number' ? parsed.step : 0
  const current = steps[step] as unknown
  const name = typeof current === 'string' ? current
    : typeof current === 'object' && current !== null && typeof (current as { name?: unknown }).name === 'string'
      ? (current as { name: string }).name : null
  return { state: parsed.state, step: step + 1, steps: steps.length, name }
}

export const FIX_BOOT = (disk: string) => [
  'set -e',
  `esp=$(lsblk -lnpo NAME,PARTTYPE ${disk} | awk '$2 == "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" {print $1}')`,
  `root=$(lsblk -lnpo NAME,TYPE ${disk} | awk '$2 == "part" {print $1}' | grep -vx "$esp")`,
  'mount -t acfs "$root" /mnt',
  'mount "$esp" /mnt/boot',
  "sed -i 's/ autodetect//' /mnt/etc/mkinitcpio.conf",
  'sed -i \'/^LINUX_OPTIONS=/s/"$/ console=tty0 console=ttyS0,115200n8"/\' /mnt/etc/sdboot-manage.conf',
  "arch-chroot /mnt sh -c 'mkinitcpio -P && sdboot-manage gen'",
  'sync',
  'umount -R /mnt',
].join('\n')

export const CHECK = 'findmnt -no SOURCE,FSTYPE / && uname -r'

export class IsoInstall {
  static readonly FROM_ISO = '.from-iso.qcow2'
  static readonly KNOWN_OS = 'f866410 (2026-11-22)'
  static readonly SIZE = '32G'
  static readonly BOOT_SECONDS = 600
  static readonly INSTALL_SECONDS = 3600
  static readonly POLL_MS = 10_000
  readonly #machine: Machine
  readonly #work: Machine
  readonly #say: Say
  readonly #log: string

  readonly #kvm: boolean

  constructor(machine: Machine, work: Machine, kvm: boolean, name: string, say: Say) {
    this.#machine = machine
    this.#work = work
    this.#kvm = kvm
    this.#say = say
    this.#log = join(machine.logs, `install-${name}.log`)
  }

  async run(iso: string, out: string): Promise<string> {
    const work = this.#work
    rmSync(work.dir, { recursive: true, force: true })
    for (const dir of [work.run, work.logs, work.sockets, this.#machine.logs]) mkdirSync(dir, { recursive: true })
    const qemu = this.#machine.qemu()
    const [, vars] = this.#machine.firmware()
    const disk = join(work.dir, 'disk.qcow2')
    this.#check(spawnSync(qemu.img, ['create', '-q', '-f', 'qcow2', disk, IsoInstall.SIZE], { encoding: 'utf8' }), 'qemu-img create')
    copyFileSync(vars, join(work.dir, 'vars.fd'))
    try {
      this.#say(`booting ${iso} (the installer)`)
      const accel = await this.#boot(['-drive', `file=${iso},media=cdrom,readonly=on,if=none,id=cd0`, '-device', 'ide-cd,drive=cd0,bootindex=0'])
      const target = await this.#install()
      this.#say('fixing the initramfs and the boot entries for any disk')
      this.#note(await this.#exec(FIX_BOOT(target), 900_000))
      await this.#exec('sync', 60_000)
      await this.#down()
      this.#say('checking the first boot of the installed system')
      copyFileSync(vars, join(work.dir, 'vars.fd'))
      await this.#boot(['-snapshot'], accel)
      const check = await this.#exec(CHECK, 60_000)
      this.#note(`first boot: ${check.replace(/\n/g, ' ')}`)
      await this.#down()
      if (!/\sacfs\b/.test(check)) throw new Error(`vm: the installed system's root is not acfs (${check.trim()}); see ${this.#log}`)
      this.#say(`compressing into ${out}`)
      const part = `${out}.part`
      const converted = spawnSync(qemu.img, ['convert', '-c', '-O', 'qcow2', '-o', 'compression_type=zstd', disk, part], { encoding: 'utf8' })
      this.#check(converted, 'qemu-img convert')
      renameSync(part, out)
      return out
    } finally {
      const pid = work.pid()
      if (pid !== null) work.abandon(pid)
      rmSync(work.dir, { recursive: true, force: true })
    }
  }

  async #boot(extra: string[], accel?: Accel): Promise<Accel> {
    const first = accel ?? preferredAccel(this.#machine.host, this.#kvm)
    if (await this.#start(extra, first)) return first
    if (first === 'tcg') throw new Error(`vm: the installer VM did not start; see ${join(this.#work.logs, 'qemu.log')}`)
    this.#say(`${first.toUpperCase()} did not start the installer VM: emulating (TCG), much slower`)
    if (await this.#start(extra, 'tcg')) return 'tcg'
    throw new Error(`vm: the installer VM did not start; see ${join(this.#work.logs, 'qemu.log')}`)
  }

  async #start(extra: string[], accel: Accel): Promise<boolean> {
    const work = this.#work
    const [code] = this.#machine.firmware()
    const args = [
      '-name', 'acdev-install', '-machine', 'q35', ...accelArgs(accel),
      '-smp', '4', '-m', '8G',
      '-drive', `if=pflash,format=raw,readonly=on,file=${code}`,
      '-drive', `if=pflash,format=raw,file=${join(work.dir, 'vars.fd')}`,
      '-drive', `file=${join(work.dir, 'disk.qcow2')},format=qcow2,if=none,id=hd0`, '-device', 'virtio-blk-pci,drive=hd0,bootindex=1',
      ...extra,
      '-vga', 'std', '-display', 'none', '-nic', 'user,model=virtio-net-pci',
      '-chardev', `socket,path=${work.qga},server=on,wait=off,id=qga0`,
      '-device', 'virtio-serial', '-device', 'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0',
      '-qmp', `unix:${work.qmp},server=on,wait=off`,
      '-chardev', `file,id=serial0,path=${work.serial}`, '-serial', 'chardev:serial0', '-parallel', 'none',
      '-pidfile', join(work.run, 'qemu.pid'),
    ]
    rmSync(join(work.run, 'qemu.pid'), { force: true })
    const child = spawnDetached([this.#machine.qemu().system, ...args], openSync(join(work.logs, 'qemu.log'), 'w'), this.#machine.env)
    for (let i = 0; i < 100 && work.pid() === null && !child.exited(); i++) await new Promise((r) => setTimeout(r, 100))
    if (work.pid() === null) return false
    if (await GuestAgent.ping(work.qga, IsoInstall.BOOT_SECONDS)) return true
    throw new Error(`vm: no guest agent in the installer VM after ${IsoInstall.BOOT_SECONDS} s; see ${work.serial}`)
  }

  async #install(): Promise<string> {
    const disk = emptyDisk(await this.#exec(ACINSTALL.probe, 120_000).catch((error: Error) => {
      throw new InstallerChanged(`${ACINSTALL.probe} failed: ${error.message}`)
    }))
    const agent = await GuestAgent.open(this.#work.qga)
    try {
      await agent.write(ACINSTALL.plan, Buffer.from(installPlan(disk, randomBytes(18).toString('base64url'))))
    } finally {
      agent.close()
    }
    await this.#exec(`chmod 600 ${ACINSTALL.plan}; setsid sh -c "${ACINSTALL.install} < ${ACINSTALL.plan} > /run/acinstaller-install.out 2>&1; `
      + `rm -f ${ACINSTALL.plan}" >/dev/null 2>&1 < /dev/null &`, 30_000)
    const deadline = Date.now() + IsoInstall.INSTALL_SECONDS * 1000
    let status: InstallStatus | null = null
    for (;;) {
      await new Promise((r) => setTimeout(r, IsoInstall.POLL_MS))
      status = installStatus(await this.#exec(`cat ${ACINSTALL.status} 2>/dev/null || true`, 30_000))
      if (status) this.#say(`installing: step ${status.step} of ${status.steps}${status.name ? ` (${status.name})` : ''}`)
      if (status && status.state !== 'running') break
      if (Date.now() > deadline) throw new Error(`vm: the installer still runs after ${IsoInstall.INSTALL_SECONDS} s`)
    }
    const log = await this.#exec(`cat ${ACINSTALL.log} /run/acinstaller-install.out 2>/dev/null || true`, 60_000)
    this.#note(log)
    if (status.state !== 'done') {
      throw new Error(`vm: the installation failed (${status.state}); last lines:\n${log.trim().split('\n').slice(-30).join('\n')}`)
    }
    return disk
  }

  async #exec(command: string, timeoutMs: number): Promise<string> {
    const agent = await GuestAgent.open(this.#work.qga)
    try {
      const done = await agent.exec(command, timeoutMs)
      if (done.code !== 0) throw new Error(`${command.split('\n')[0]}: exit ${done.code}: ${done.stderr.toString().trim().slice(-500)}`)
      return done.stdout.toString()
    } finally {
      agent.close()
    }
  }

  async #down(): Promise<void> {
    const pid = this.#work.pid()
    await this.#exec('systemctl poweroff --no-block', 30_000).catch(() => undefined)
    for (let i = 0; i < 90 && pid !== null && this.#work.pid() !== null; i++) await new Promise((r) => setTimeout(r, 2_000))
    if (this.#work.pid() !== null && pid !== null) this.#work.abandon(pid)
  }

  #note(text: string): void {
    appendFileSync(this.#log, `${text.trimEnd()}\n`)
  }

  #check(ran: ReturnType<typeof spawnSync>, what: string): void {
    if (ran.status !== 0) throw new Error(`vm: ${what} failed: ${String(ran.stderr ?? ran.error ?? '').trim()}`)
  }
}
