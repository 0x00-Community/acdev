import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { which } from 'acdev/launcher'
import { Runtime } from '../runtime.ts'
import { GuestAgent, monitor, type ExecResult } from './channel.ts'
import { crateBinary } from './binary.ts'
import { Devd, PORT, RelayTransport, SocketTransport, type Transport } from './devd.ts'

export interface StartOptions {
  readonly image?: string
  readonly fresh?: boolean
  readonly share?: string
  readonly display?: 'window' | 'none' | 'vnc' | 'viewer'
  readonly gl?: boolean
}

export type Link = { readonly kind: 'vsock' } | { readonly kind: 'unix'; readonly path: string } | { readonly kind: 'tcp'; readonly port: number }

const LINKS = ['vsock', 'unix', 'tcp'] as const

export function defaultLink(platform: NodeJS.Platform): Link['kind'] {
  return platform === 'linux' ? 'vsock' : 'tcp'
}

export class Machine {
  static readonly DIST = 'https://calbin-1318886512.cos.ap-beijing.myqcloud.com/iso'
  static readonly MOUNT_TAG = 'acdev'
  static readonly SHARE = '/mnt/acdev'
  static readonly FIRMWARE: readonly (readonly [string, string])[] = [
    ['/usr/share/OVMF/OVMF_CODE_4M.fd', '/usr/share/OVMF/OVMF_VARS_4M.fd'],
    ['/usr/share/edk2/x64/OVMF_CODE.4m.fd', '/usr/share/edk2/x64/OVMF_VARS.4m.fd'],
    ['/usr/share/edk2/ovmf/OVMF_CODE.fd', '/usr/share/edk2/ovmf/OVMF_VARS.fd'],
    ['/usr/share/OVMF/OVMF_CODE.fd', '/usr/share/OVMF/OVMF_VARS.fd'],
    ['/usr/share/qemu/edk2-x86_64-code.fd', '/usr/share/qemu/edk2-i386-vars.fd'],
  ]
  readonly dir: string
  readonly env: NodeJS.ProcessEnv
  static readonly ROOT = realpathSync(join(import.meta.dirname, '..', '..'))
  static readonly DEVD = '/usr/local/bin/acdevd'
  static readonly UNIT = '/etc/systemd/system/acdevd.service'

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
    const data = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share')
    this.dir = resolve(env['ACDEV_VM_DIR'] || join(data, 'acdev', 'vm'))
  }

  get images(): string {
    return join(this.dir, 'images')
  }

  get run(): string {
    return join(this.dir, 'run')
  }

  get logs(): string {
    return join(this.dir, 'logs')
  }

  get serial(): string {
    return join(this.logs, 'serial.log')
  }

  get qmp(): string {
    return join(this.run, 'qmp.sock')
  }

  get qga(): string {
    return join(this.run, 'qga.sock')
  }

  get key(): string {
    return join(this.run, 'key')
  }

  get linkFile(): string {
    return join(this.run, 'link.json')
  }

  linkKind(): Link['kind'] {
    const given = this.env['ACDEV_VM_TRANSPORT']
    if (given) {
      if (!(LINKS as readonly string[]).includes(given)) throw new Error(`vm: ACDEV_VM_TRANSPORT=${given}: ${LINKS.join(', ')}`)
      return given as Link['kind']
    }
    return defaultLink(process.platform)
  }

  async newLink(): Promise<Link> {
    const kind = this.linkKind()
    if (kind === 'vsock') return { kind }
    if (kind === 'unix') return { kind, path: join(this.run, 'devd.sock') }
    return { kind, port: await Machine.#freePort() }
  }

  static #freePort(): Promise<number> {
    return new Promise((done, fail) => {
      const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
        const address = probe.address()
        probe.close(() => (typeof address === 'object' && address ? done(address.port) : fail(new Error('vm: no free port'))))
      })
    })
  }

  link(): Link {
    if (!existsSync(this.linkFile)) return { kind: 'vsock' }
    return JSON.parse(readFileSync(this.linkFile, 'utf8')) as Link
  }

  describeLink(link: Link = this.link()): string {
    if (link.kind === 'vsock') return `vsock (cid ${this.cid()})`
    return link.kind === 'unix' ? `a forwarded socket (${link.path})` : `a forwarded port (127.0.0.1:${link.port})`
  }

  pid(): number | null {
    const file = join(this.run, 'qemu.pid')
    if (!existsSync(file)) return null
    const pid = Number(readFileSync(file, 'utf8').trim())
    try {
      process.kill(pid, 0)
      return pid
    } catch {
      return null
    }
  }

  running(): number {
    const pid = this.pid()
    if (pid === null) throw new Error(`vm: no guest is running from ${this.dir} (acdev vm start)`)
    return pid
  }

  async fetch(say: (line: string) => void): Promise<string> {
    const dist = (this.env['ACDEV_VM_DIST'] || Machine.DIST).replace(/\/+$/, '')
    mkdirSync(this.images, { recursive: true })
    const name = (await Machine.#text(`${dist}/latest-qcow2`)).trim()
    if (!/^[\w.-]+\.qcow2$/.test(name)) throw new Error(`vm: ${dist}/latest-qcow2 names no qcow2 image (${name})`)
    const file = join(this.images, name)
    if (existsSync(file)) say(`${name} is already here`)
    else await this.#download(`${dist}/${name}`, file, say)
    const latest = join(this.images, 'latest.qcow2')
    rmSync(latest, { force: true })
    symlinkSync(name, latest)
    return file
  }

  async #download(url: string, file: string, say: (line: string) => void): Promise<void> {
    const want = (await Machine.#text(`${url}.sha256`)).trim().split(/\s+/, 1)[0]
    say(`downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok || !response.body) throw new Error(`vm: ${url}: HTTP ${response.status}`)
    const part = `${file}.part`
    const hash = createHash('sha256')
    const out = createWriteStream(part)
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      hash.update(chunk as Buffer)
      if (!out.write(chunk)) await new Promise((done) => out.once('drain', done))
    }
    await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())))
    const got = hash.digest('hex')
    if (got !== want) {
      rmSync(part, { force: true })
      throw new Error(`vm: ${basename(file)}: SHA-256 is ${got}, not ${want}`)
    }
    renameSync(part, file)
    say(`${basename(file)}: SHA-256 matches`)
  }

  static async #text(url: string): Promise<string> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`vm: ${url}: HTTP ${response.status}`)
    return response.text()
  }

  firmware(): readonly [string, string] {
    const code = this.env['OVMF_CODE']
    const vars = this.env['OVMF_VARS']
    if (code && vars) return [code, vars]
    const found = Machine.FIRMWARE.find(([c, v]) => existsSync(c) && existsSync(v))
    if (!found) throw new Error('vm: no UEFI firmware: install OVMF (ovmf / edk2-ovmf) or set OVMF_CODE and OVMF_VARS')
    return found
  }

  static directory(path: string): string {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`vm: ${path} is not a directory`)
    return realpathSync(path)
  }

  cid(): number {
    const digest = createHash('sha256').update(this.dir).digest()
    return 3 + (digest.readUInt32LE(0) % 0xffff0)
  }

  devd(): Devd {
    const key = existsSync(this.key) ? Buffer.from(readFileSync(this.key, 'utf8').trim()) : null
    return new Devd(this.#transport(this.link()), key)
  }

  #transport(link: Link): Transport {
    if (link.kind === 'unix') return new SocketTransport({ path: link.path })
    if (link.kind === 'tcp') return new SocketTransport({ host: '127.0.0.1', port: link.port })
    return new RelayTransport(Devd.binary(Machine.ROOT, this.env), this.cid())
  }

  static kvm(): boolean {
    try {
      openSync('/dev/kvm', 'r+')
      return true
    } catch {
      return false
    }
  }

  overlay(image: string, fresh: boolean): boolean {
    const disk = join(this.dir, 'disk.qcow2')
    const base = join(this.dir, 'disk.base')
    const same = existsSync(disk) && existsSync(base) && readFileSync(base, 'utf8').trim() === image
    if (same && !fresh) return false
    rmSync(disk, { force: true })
    rmSync(join(this.dir, 'vars.fd'), { force: true })
    const made = spawnSync('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', image, '-F', 'qcow2', disk], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(`vm: qemu-img create: ${made.stderr.trim()}`)
    writeFileSync(base, `${image}\n`)
    return true
  }

  args(options: StartOptions, kvm: boolean, link: Link = { kind: 'vsock' }): string[] {
    const [code] = this.firmware()
    const display = options.display ?? 'window'
    const accel = kvm ? ['-accel', 'kvm', '-cpu', 'host'] : ['-accel', 'tcg,thread=multi', '-cpu', 'max']
    const gpu = options.gl ? ['-device', 'virtio-vga-gl'] : ['-device', 'virtio-vga']
    const shown = ['-display', Machine.#display(display, options.gl ?? false)]
    const share = options.share
      ? ['-virtfs', `local,path=${options.share},mount_tag=${Machine.MOUNT_TAG},security_model=none,id=share0`] : []
    return [
      '-name', 'acdev', '-machine', 'q35', ...accel,
      '-smp', this.env['ACDEV_VM_CPUS'] || '4', '-m', this.env['ACDEV_VM_MEMORY'] || '8G',
      '-drive', `if=pflash,format=raw,readonly=on,file=${code}`,
      '-drive', `if=pflash,format=raw,file=${join(this.dir, 'vars.fd')}`,
      '-drive', `file=${join(this.dir, 'disk.qcow2')},format=qcow2,if=none,id=hd0`,
      '-device', 'virtio-blk-pci,drive=hd0,bootindex=1',
      '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci',
      '-nic', `user,model=virtio-net-pci${Machine.#forward(link)}`,
      '-fw_cfg', `name=opt/acdev/key,file=${this.key}`,
      '-chardev', `socket,path=${this.qga},server=on,wait=off,id=qga0`,
      '-device', 'virtio-serial', '-device', 'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0',
      '-qmp', `unix:${this.qmp},server=on,wait=off`,
      ...(link.kind === 'vsock' ? ['-device', `vhost-vsock-pci,guest-cid=${this.cid()}`] : []),
      '-chardev', `file,id=serial0,path=${this.serial}`, '-serial', 'chardev:serial0',
      '-pidfile', join(this.run, 'qemu.pid'),
      ...gpu, ...shown, ...share,
    ]
  }

  static #display(display: NonNullable<StartOptions['display']>, gl: boolean): string {
    if (display === 'none') return 'none'
    if (display === 'vnc') return 'vnc=127.0.0.1:0'
    if (display === 'viewer') return 'dbus,p2p=yes'
    return gl ? 'gtk,gl=on' : 'gtk'
  }

  static #forward(link: Link): string {
    if (link.kind === 'unix') return `,hostfwd=unix:${link.path}-:${PORT}`
    return link.kind === 'tcp' ? `,hostfwd=tcp:127.0.0.1:${link.port}-:${PORT}` : ''
  }

  async #freshRun(): Promise<Link> {
    for (const name of ['qga.sock', 'qmp.sock', 'qemu.pid', 'devd.sock', 'key']) rmSync(join(this.run, name), { force: true })
    const link = await this.newLink()
    writeFileSync(this.linkFile, `${JSON.stringify(link)}\n`)
    writeFileSync(this.key, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    return link
  }

  async start(options: StartOptions, say: (line: string) => void): Promise<number> {
    const already = this.pid()
    if (already !== null) throw new Error(`vm: a guest is already running from ${this.dir} (pid ${already})`)
    if (options.gl && options.display && options.display !== 'window') throw new Error('vm: --gl needs a window')
    for (const tool of ['qemu-system-x86_64', 'qemu-img']) {
      if (!which(tool, this.env)) throw new Error(`vm: ${tool} is not on PATH (install qemu-system-x86 and qemu-utils)`)
    }
    const image = realpathSync(options.image ?? join(this.images, 'latest.qcow2'))
    mkdirSync(this.run, { recursive: true })
    mkdirSync(this.logs, { recursive: true })
    if (this.overlay(image, options.fresh ?? false)) say(`new overlay disk on ${image}`)
    const vars = join(this.dir, 'vars.fd')
    if (!existsSync(vars)) copyFileSync(this.firmware()[1], vars)
    const kvm = Machine.kvm()
    if (!kvm) say('cannot open /dev/kvm: emulating (TCG), much slower')
    const args = this.args(options, kvm, await this.#freshRun())
    writeFileSync(join(this.logs, 'qemu.cmd'), `${['qemu-system-x86_64', ...args].join(' ')}\n`)
    writeFileSync(this.serial, '')
    writeFileSync(join(this.run, 'share'), `${options.share ?? ''}\n`)
    writeFileSync(join(this.run, 'display'), `${options.display ?? 'window'}\n`)
    const log = openSync(join(this.logs, 'qemu.log'), 'w')
    const child = Runtime.spawn(['setsid', 'qemu-system-x86_64', ...args], { stdio: ['ignore', log, log] })
    child.process.unref()
    for (let i = 0; i < 100; i++) {
      const pid = this.pid()
      if (pid !== null) return pid
      if (child.process.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`vm: qemu did not start: ${readFileSync(join(this.logs, 'qemu.log'), 'utf8').trim()}`)
  }

  async stop(seconds = 60): Promise<'off' | 'killed' | 'not running'> {
    const pid = this.pid()
    if (pid === null) return 'not running'
    await monitor(this.qmp, 'system_powerdown').catch(() => undefined)
    for (let i = 0; i < seconds * 2; i++) {
      if (this.pid() === null) return 'off'
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    process.kill(pid, 'SIGTERM')
    return 'killed'
  }

  view(): number {
    this.running()
    const display = join(this.run, 'display')
    if (!existsSync(display) || readFileSync(display, 'utf8').trim() !== 'viewer') {
      throw new Error('vm: the guest was started without --viewer (its screen is in QEMU\'s own window or none)')
    }
    const viewer = crateBinary(Machine.ROOT, { crate: 'viewer', name: 'acdev-viewer', variable: 'ACDEV_VIEWER' }, this.env)
    const log = openSync(join(this.logs, 'viewer.log'), 'a')
    const title = `acdev: ${basename(this.dir)}`
    const child = Runtime.spawn(['setsid', viewer, '--qmp', this.qmp, '--title', title], { stdio: ['ignore', log, log], env: this.env })
    child.process.unref()
    return child.pid
  }

  async ready(seconds: number): Promise<boolean> {
    this.running()
    return GuestAgent.ping(this.qga, seconds)
  }

  async screenshot(file: string): Promise<string> {
    this.running()
    const target = resolve(file)
    mkdirSync(dirname(target), { recursive: true })
    await monitor(this.qmp, 'screendump', { filename: target, format: 'png' })
    return target
  }

  async exec(command: string, timeoutMs = 600_000): Promise<ExecResult> {
    this.running()
    const agent = await GuestAgent.open(this.qga)
    try {
      return await agent.exec(command, timeoutMs)
    } finally {
      agent.close()
    }
  }

  async push(local: string, remote: string | undefined): Promise<string> {
    this.running()
    const from = resolve(local)
    if (!existsSync(from)) throw new Error(`vm: no ${local}`)
    const to = remote ?? posix.join('/opt/acdev', basename(from))
    await this.devd().push(Devd.files(from, to))
    return to
  }

  async pull(remote: string, local: string | undefined): Promise<{ target: string; files: number }> {
    this.running()
    const name = posix.basename(remote)
    const given = resolve(local ?? name)
    const target = local !== undefined && existsSync(given) && statSync(given).isDirectory() ? join(given, name) : given
    return { target, files: await this.devd().pull(remote, target) }
  }

  async installDevd(say: (line: string) => void, seconds = 30): Promise<string> {
    const binary = Devd.binary(Machine.ROOT, this.env)
    const data = readFileSync(binary)
    const sum = createHash('sha256').update(data).digest('hex')
    const agent = await GuestAgent.open(this.qga)
    try {
      const there = await agent.exec(`sha256sum ${Machine.DEVD} 2>/dev/null`, 30_000)
      if (!there.stdout.toString().startsWith(sum)) {
        say('installing acdevd in the guest')
        await agent.write(`${Machine.DEVD}.new`, data)
        await agent.write(Machine.UNIT, Buffer.from(UNIT))
        await Machine.#check(agent, `chmod 755 ${Machine.DEVD}.new && mv ${Machine.DEVD}.new ${Machine.DEVD} && `
          + 'systemctl daemon-reload && systemctl enable acdevd >/dev/null 2>&1 && systemctl restart acdevd')
      } else {
        await Machine.#check(agent, 'systemctl is-active -q acdevd || systemctl restart acdevd')
      }
    } finally {
      agent.close()
    }
    const devd = this.devd()
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      try {
        return await devd.version()
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`vm: acdevd does not answer over ${this.describeLink()}: ${(error as Error).message}`)
        await new Promise((done) => setTimeout(done, 1_000))
      }
    }
  }

  static async #check(agent: GuestAgent, command: string): Promise<void> {
    const done = await agent.exec(command, 120_000)
    if (done.code !== 0) throw new Error(`vm: ${command}: exit ${done.code}: ${done.stderr.toString().trim()}`)
  }

  async mount(): Promise<string> {
    this.running()
    const share = readFileSync(join(this.run, 'share'), 'utf8').trim()
    if (!share) throw new Error('vm: the guest was started without --share')
    const options = 'trans=virtio,version=9p2000.L,msize=1048576'
    const done = await this.exec(`modprobe 9pnet_virtio 9p 2>/dev/null; mkdir -p ${Machine.SHARE} && `
      + `{ mountpoint -q ${Machine.SHARE} || mount -t 9p -o ${options} ${Machine.MOUNT_TAG} ${Machine.SHARE}; }`, 60_000)
    if (done.code !== 0) throw new Error(`vm: mount: ${done.stderr.toString().trim()}`)
    return share
  }

  async console(): Promise<string[]> {
    const entries = '/boot/loader/entries/*.conf /efi/loader/entries/*.conf /boot/efi/loader/entries/*.conf'
    const done = await this.exec(`for f in ${entries}; do [ -f "$f" ] || continue; `
      + 'sed -i -e "/^options /s/ console=[^ ]*//g" -e "/^options /s/ loglevel=6//g" '
      + '-e "s/^options .*/& console=tty0 console=ttyS0,115200 loglevel=6/" "$f"; echo "$f"; done', 60_000)
    if (done.code !== 0) throw new Error(`vm: console: ${done.stderr.toString().trim()}`)
    return done.stdout.toString().trim().split('\n').filter(Boolean)
  }

  image(): string | null {
    const latest = join(this.images, 'latest.qcow2')
    return existsSync(latest) ? join(this.images, readlinkSync(latest)) : null
  }
}

const UNIT = `[Unit]
Description=acdev device daemon (vsock, or TCP with the key from fw_cfg)
After=local-fs.target network.target

[Service]
ExecStartPre=-/usr/bin/modprobe qemu_fw_cfg
ExecStart=${Machine.DEVD} serve
Restart=always

[Install]
WantedBy=multi-user.target
`
