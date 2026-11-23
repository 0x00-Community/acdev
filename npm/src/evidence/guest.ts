import { journalSince } from '../vm/logs.ts'

export async function guestJournal(since: Date): Promise<string> {
  const { Machine } = await import('../vm/machine.ts')
  const out: Buffer[] = []
  const err: Buffer[] = []
  const code = await new Machine().devd().run(['/bin/sh', '-c', journalSince(since)], {
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
  })
  if (code !== 0) throw new Error(`journalctl in the guest exited with ${code}: ${Buffer.concat(err).toString().trim()}`)
  return Buffer.concat(out).toString()
}
