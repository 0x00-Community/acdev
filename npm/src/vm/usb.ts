import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import { monitor } from './channel.ts'
import { XHCI } from './hardware.ts'

export interface UsbStick {
  readonly id: string
  readonly image: string
}

export type Qmp = (command: string, args?: unknown) => Promise<unknown>

export interface Formatter {
  readonly tool: string
  readonly args: (image: string) => string[]
}

export class Usb {
  static readonly SIZE = 256 << 20
  static readonly LABEL = 'ACDEV'
  static readonly TOOLS: readonly { readonly name: string; readonly args: (image: string) => string[] }[] = [
    { name: 'mkfs.vfat', args: (image) => ['-n', Usb.LABEL, image] },
    { name: 'mkfs.exfat', args: (image) => ['-n', Usb.LABEL, image] },
  ]
  static readonly DEL_WAIT_MS = 10_000

  readonly #list: string
  readonly #qmp: Qmp

  constructor(run: string, qmp: string | Qmp) {
    this.#list = join(run, 'usb.json')
    this.#qmp = typeof qmp === 'string' ? (command, args) => monitor(qmp, command, args) : qmp
  }

  static size(text: string | undefined): number {
    if (text === undefined) return Usb.SIZE
    const found = /^(\d+)([KMG]?)$/i.exec(text.trim())
    const units: Record<string, number> = { '': 1, K: 1 << 10, M: 1 << 20, G: 1 << 30 }
    const bytes = found ? Number(found[1]) * units[found[2]!.toUpperCase()]! : 0
    if (bytes < 1 << 20) throw new Error(`vm usb add: --size ${text}: a size like 256M or 2G, at least 1M`)
    return bytes
  }

  static formatter(dirs: readonly string[] = Usb.searched(process.env['PATH'] ?? '')): Formatter | null {
    for (const tool of Usb.TOOLS) {
      const found = dirs.map((dir) => join(dir, tool.name)).find((file) => existsSync(file))
      if (found) return { tool: found, args: tool.args }
    }
    return null
  }

  static searched(path: string): string[] {
    return [...path.split(delimiter).filter(Boolean), '/usr/sbin', '/sbin']
  }

  static create(image: string, bytes: number, formatter: Formatter | null): void {
    if (!formatter) {
      throw new Error(`vm usb add: ${image} does not exist and there is no mkfs.vfat or mkfs.exfat to format a new one; `
        + 'install dosfstools (mkfs.vfat) or exfatprogs (mkfs.exfat), or give an existing disk image')
    }
    writeFileSync(image, '', { flag: 'wx' })
    truncateSync(image, bytes)
    const made = spawnSync(formatter.tool, formatter.args(image), { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(`vm usb add: ${basename(formatter.tool)} ${image}: ${(made.stderr || made.error?.message || '').trim()}`)
  }

  list(): UsbStick[] {
    if (!existsSync(this.#list)) return []
    try {
      return JSON.parse(readFileSync(this.#list, 'utf8')) as UsbStick[]
    } catch {
      return []
    }
  }

  #save(sticks: readonly UsbStick[]): void {
    writeFileSync(this.#list, `${JSON.stringify(sticks)}\n`)
  }

  async add(given: string, bytes: number, formatter: Formatter | null = Usb.formatter()): Promise<UsbStick> {
    const image = resolve(given)
    const sticks = this.list()
    if (sticks.some((stick) => stick.image === image)) throw new Error(`vm usb add: ${image} is already plugged in`)
    if (!existsSync(image)) Usb.create(image, bytes, formatter)
    const taken = new Set(sticks.map((stick) => stick.id))
    let n = 0
    while (taken.has(`usb${n}`)) n++
    const id = `usb${n}`
    await this.#qmp('blockdev-add', { 'node-name': `${id}-disk`, driver: 'raw', file: { driver: 'file', filename: image } })
    try {
      await this.#qmp('device_add', { driver: 'usb-storage', bus: `${XHCI}.0`, drive: `${id}-disk`, id, removable: true })
    } catch (error) {
      await this.#qmp('blockdev-del', { 'node-name': `${id}-disk` }).catch(() => undefined)
      throw error
    }
    const stick = { id, image }
    this.#save([...sticks, stick])
    return stick
  }

  async remove(which: string | undefined, sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): Promise<UsbStick> {
    const sticks = this.list()
    const image = which === undefined ? null : resolve(which)
    const stick = which === undefined ? sticks.at(-1) : sticks.find((s) => s.id === which || s.image === image)
    if (!stick) {
      const plugged = sticks.length ? sticks.map((s) => `${s.id} ${s.image}`).join(', ') : 'none'
      throw new Error(`vm usb remove: ${which === undefined ? 'no USB stick is plugged in' : `no USB stick ${which}`} (plugged: ${plugged})`)
    }
    await this.#qmp('device_del', { id: stick.id })
    const until = Date.now() + Usb.DEL_WAIT_MS
    for (;;) {
      try {
        await this.#qmp('blockdev-del', { 'node-name': `${stick.id}-disk` })
        break
      } catch (error) {
        if (Date.now() > until) throw new Error(`vm usb remove: the guest did not let go of ${stick.id}: ${(error as Error).message}`)
        await sleep(200)
      }
    }
    this.#save(sticks.filter((s) => s.id !== stick.id))
    return stick
  }
}
