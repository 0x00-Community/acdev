import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { which } from '../../launcher.mjs'
import { Frames, type Frame, type Transport } from '../../src/vm/devd.ts'
import { Machine } from '../../src/vm/machine.ts'
import { env } from '../helpers.ts'

export const CLI = join(import.meta.dir, '../../src/cli.ts')

export function serve(path: string, answer: (socket: Socket, message: Record<string, unknown>) => void, hello = ''): Server {
  const server = createServer((socket) => {
    if (hello) socket.write(hello)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.trim()) answer(socket, JSON.parse(line) as Record<string, unknown>)
      }
    })
  })
  server.listen(path)
  return server
}

export const reply = (socket: Socket, value: unknown) => socket.write(`${JSON.stringify({ return: value })}\n`)

export class Scripted implements Transport {
  readonly sent: Frame[] = []
  readonly answer: (sent: Frame[]) => Frame[]

  constructor(answer: (sent: Frame[]) => Frame[]) {
    this.answer = answer
  }

  open() {
    const decoder = new Frames()
    const sent = this.sent
    const answer = this.answer
    let replies: Frame[] = []
    return {
      write: (data: Buffer) => {
        sent.push(...decoder.push(data))
        replies = answer(sent)
      },
      end: () => undefined,
      frames: (async function* () {
        await Promise.resolve()
        yield* replies
      })(),
      bytes: async function* () {},
      close: () => undefined,
    }
  }
}

export const frame = (kind: string, body: Buffer = Buffer.alloc(0)): Frame => ({ kind, body })
export const u32 = (value: number) => {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value, 0)
  return out
}

export const IMAGE = process.env['ACDEV_VM_TEST_IMAGE'] ?? ''
export const QEMU = which('qemu-system-x86_64') !== null && Machine.kvm() && IMAGE !== '' && existsSync(IMAGE)

export async function devLoop(vmDir: string): Promise<string[]> {
  const project = join(vmDir, 'hello')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'Cargo.toml'), '[package]\nname = "hello"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n')
  const source = (word: string) => writeFileSync(join(project, 'src', 'main.rs'),
    `fn main() { println!("${word}"); std::thread::sleep(std::time::Duration::from_secs(600)); }\n`)
  source('v1')
  const child = spawn(process.execPath, [CLI, 'vm', 'dev', project], { env: env({ ACDEV_VM_DIR: vmDir }), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  const seen = async (word: string) => {
    for (let waited = 0; !out.includes(word); waited += 500) {
      if (waited > 240_000) throw new Error(`no ${word} from acdev vm dev: ${out}`)
      await new Promise((tick) => setTimeout(tick, 500))
    }
    return word
  }
  try {
    const words = [await seen('v1')]
    source('v2')
    words.push(await seen('v2'))
    return words
  } finally {
    child.kill('SIGINT')
    await new Promise((done) => child.on('close', done))
  }
}
