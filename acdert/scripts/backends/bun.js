import { spawn } from 'node:child_process'

const env = process.env
const transport = () => ({ sockets: env.ACDE_APP_SOCKETS ?? null, channel: env.ACDE_APP_CHANNEL ?? null, control: env.ACDE_APP_CONTROL ?? null })
const query = (url, name, fallback) => Number(url.searchParams.get(name) ?? fallback)

const server = Bun.serve({
  port: Number(process.env.PORT),
  routes: {
    '/api/hello': new Response('hello from bun'),
    '/api/pid': () => new Response(String(process.pid)),
    '/api/env': () => Response.json(transport()),
    '/api/child': () => new Response(String(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)),
  },
  async fetch(req, server) {
    const url = new URL(req.url)
    switch (url.pathname) {
      case '/ws':
        return server.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
      case '/api/echo':
        return new Response(`echo:${req.method}:${await req.text()}`)
      case '/api/chunked':
        return new Response(new ReadableStream({
          async start(controller) {
            for (let i = 0; i < query(url, 'n', 3); i++) {
              controller.enqueue(new TextEncoder().encode(`chunk${i};`))
              await Bun.sleep(query(url, 'ms', 100))
            }
            controller.close()
          },
        }))
      case '/api/slow':
        await Bun.sleep(query(url, 'ms', 100))
        return new Response(`slow:${url.searchParams.get('i')}`)
      case '/api/big': {
        const bytes = new Uint8Array(query(url, 'n', 0))
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff
        return new Response(bytes)
      }
      case '/api/sum': {
        const bytes = new Uint8Array(await req.arrayBuffer())
        let total = 0
        for (const byte of bytes) total = (total + byte) % 1000000007
        return new Response(`${bytes.length}:${total}`)
      }
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    perMessageDeflate: true,
    message(ws, message) {
      if (typeof message !== 'string') return ws.send(message)
      if (message === 'join') {
        ws.subscribe('room')
        ws.send('joined')
      } else if (message.startsWith('publish:')) {
        server.publish('room', 'room:' + message.slice(8))
      } else if (message.startsWith('big:')) {
        ws.send(message, true)
      } else {
        ws.send('echo:' + message, true)
      }
    },
  },
})

console.log(`bun backend ${process.pid} on port ${server.port ?? process.env.PORT}`)
