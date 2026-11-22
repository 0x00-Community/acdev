import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Machine } from '../machine.ts'
import { InstallerChanged, IsoInstall, isoIsNewer, type Say } from './install.ts'

export type FetchFrom = 'newest' | 'iso' | 'qcow2'

export interface Installer {
  readonly machine: Machine
  readonly work: () => Machine
  readonly kvm: boolean
}

const QCOW2 = /^[\w.-]+\.qcow2$/
const ISO = /^[\w.-]+\.iso$/

export async function newestImage(machine: Machine, latestQcow2: string, dist: string, from: FetchFrom, say: Say): Promise<string> {
  const pointer = `${dist}/${latestQcow2}`
  const qcow2 = from === 'iso' ? '' : (await text(pointer).catch(() => '')).trim()
  const guest = machine.guest
  if (guest !== 'x86_64') {
    if (QCOW2.test(qcow2) && qcow2.includes(guest)) return qcow2
    const hint = `start with --image FILE, a ${guest} image you have`
    throw new Error(`vm: no ${guest} ISO or image on ${dist} (Dopame OS ships x86_64 only so far); ${hint}`)
  }
  const iso = from === 'qcow2' ? '' : (await text(`${dist}/latest`)).trim()
  if (iso && !(ISO.test(iso) && iso.includes(guest))) throw new Error(`vm: ${dist}/latest names no ${guest} ISO (${iso})`)
  if (from === 'iso' || (from === 'newest' && iso !== '' && isoIsNewer(iso, qcow2))) {
    say(`the newest system is the ISO ${iso}${qcow2 ? ` (the image ${qcow2} is older)` : ''}: installing it into an image`)
    return `${iso.slice(0, -'.iso'.length)}${IsoInstall.FROM_ISO}`
  }
  if (!QCOW2.test(qcow2) || !qcow2.includes(guest)) throw new Error(`vm: ${pointer} names no ${guest} qcow2 image (${qcow2})`)
  return qcow2
}

export async function getImage(installer: Installer, dist: string, name: string, file: string, say: Say): Promise<void> {
  if (!name.endsWith(IsoInstall.FROM_ISO)) return download(`${dist}/${name}`, file, say)
  const iso = `${name.slice(0, -IsoInstall.FROM_ISO.length)}.iso`
  const isoFile = join(installer.machine.images, iso)
  if (!existsSync(isoFile)) await download(`${dist}/${iso}`, isoFile, say)
  try {
    await new IsoInstall(installer.machine, installer.work(), installer.kvm, name, say).run(isoFile, file)
  } catch (error) {
    if (!(error instanceof InstallerChanged)) throw error
    throw new Error(`vm: the installer's format changed (acdev knows acinstall as of os ${IsoInstall.KNOWN_OS}): ${error.message}; update acdev`)
  }
  rmSync(isoFile, { force: true })
  say(`installed ${name}`)
}

export async function download(url: string, file: string, say: Say): Promise<void> {
  const want = (await text(`${url}.sha256`)).trim().split(/\s+/, 1)[0]
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

export async function text(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`vm: ${url}: HTTP ${response.status}`)
  return response.text()
}
