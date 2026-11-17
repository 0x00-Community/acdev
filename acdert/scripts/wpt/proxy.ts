import { readFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'

const HOST = 'acde.local'

function rewrite(head: string): string {
  const [line, ...fields] = head.split('\r\n')
  const out = [line!]
  for (const field of fields) {
    const at = field.indexOf(':')
    const name = field.slice(0, at).trim().toLowerCase()
    const value = field.slice(at + 1).trim()
    if (name === 'host') out.push(`Host: ${HOST}`)
    else if (name === 'origin' || name === 'referer') out.push(`${field.slice(0, at)}: ${value.replace(/^http:\/\/localhost(:\d+)?(?=\/|$)/, `http://${HOST}`)}`)
    else out.push(field)
  }
  return out.join('\r\n')
}

function serveOwn(client: Socket, body: Buffer) {
  const head = `HTTP/1.1 200 OK\r\nContent-Type: text/javascript; charset=utf-8\r\nContent-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`
  client.end(Buffer.concat([Buffer.from(head), body]))
}

export function proxy(port: number, harness: Record<string, string>, listen = 3000) {
  const own = new Map(Object.entries(harness).map(([path, file]) => [path, readFileSync(file)]))
  createServer((client) => {
    let buffered = Buffer.alloc(0)
    let upstream: Socket | null = null
    const fail = () => {
      client.destroy()
      upstream?.destroy()
    }
    client.on('error', fail)
    const first = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      client.pause()
      client.off('data', first)
      const head = buffered.subarray(0, end).toString('latin1')
      const rest = buffered.subarray(end)
      const mine = own.get(head.split(' ')[1]?.split('?')[0] ?? '')
      if (mine) return serveOwn(client, mine)
      upstream = connect(port, '127.0.0.1')
      upstream.on('error', fail)
      upstream.write(Buffer.concat([Buffer.from(rewrite(head), 'latin1'), rest]))
      client.pipe(upstream)
      upstream.pipe(client)
    }
    client.on('data', first)
  }).listen(listen)
}
