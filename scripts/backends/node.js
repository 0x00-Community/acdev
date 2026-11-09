import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const env = process.env
const transport = () => ({ sockets: env.ACDE_APP_SOCKETS ?? null, channel: env.ACDE_APP_CHANNEL ?? null, control: env.ACDE_APP_CONTROL ?? null })

function frame(opcode, payload) {
  const head = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([head, payload])
}

function parse(buffer, onFrame) {
  let rest = buffer
  for (;;) {
    if (rest.length < 2) return rest
    const opcode = rest[0] & 0x0f
    let length = rest[1] & 0x7f
    let at = 2
    if (length === 126) {
      if (rest.length < 4) return rest
      length = rest.readUInt16BE(2)
      at = 4
    }
    if (rest.length < at + 4 + length) return rest
    const key = rest.subarray(at, at + 4)
    const payload = Buffer.from(rest.subarray(at + 4, at + 4 + length))
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]
    rest = rest.subarray(at + 4 + length)
    onFrame(opcode, payload)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local')
  const query = (name, fallback) => Number(url.searchParams.get(name) ?? fallback)
  switch (url.pathname) {
    case '/api/hello':
      return res.end('hello from node')
    case '/api/pid':
      return res.end(String(process.pid))
    case '/api/env':
      return res.end(JSON.stringify(transport()))
    case '/api/child':
      return res.end(String(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid))
    case '/api/echo': {
      let body = ''
      for await (const chunk of req) body += chunk
      return res.end(`echo:${req.method}:${body}`)
    }
    case '/api/chunked':
      res.writeHead(200, { 'content-type': 'text/plain' })
      for (let i = 0; i < query('n', 3); i++) {
        res.write(`chunk${i};`)
        await sleep(query('ms', 100))
      }
      return res.end()
    case '/api/slow':
      await sleep(query('ms', 100))
      return res.end(`slow:${url.searchParams.get('i')}`)
    case '/api/big': {
      const body = Buffer.alloc(query('n', 0))
      for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff
      return res.end(body)
    }
    case '/api/sum': {
      let count = 0
      let total = 0
      for await (const chunk of req) {
        for (const byte of chunk) total = (total + byte) % 1000000007
        count += chunk.length
      }
      return res.end(`${count}:${total}`)
    }
  }
  res.statusCode = 404
  res.end('not found')
})

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') return socket.destroy()
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = parse(Buffer.concat([buffer, chunk]), (opcode, payload) => {
      if (opcode === 1) socket.write(frame(1, Buffer.from(`echo:${payload}`)))
      else if (opcode === 2) socket.write(frame(2, payload))
      else if (opcode === 8) socket.end(frame(8, payload.subarray(0, 2)))
    })
  })
  socket.on('error', () => undefined)
})

server.listen(Number(process.env.PORT))
console.log(`node backend ${process.pid} on port ${process.env.PORT}`)
