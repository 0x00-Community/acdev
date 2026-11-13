import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/hello') return res.end('hello')
  if (url.pathname === '/echo') return req.pipe(res)
  if (url.pathname === '/big') {
    const size = Number(url.searchParams.get('n'))
    res.setHeader('content-length', size)
    for (let left = size; left > 0; left -= 100_000) {
      if (!res.write(Buffer.alloc(Math.min(left, 100_000), 120))) await new Promise((ok) => res.once('drain', ok))
    }
    return res.end()
  }
  if (url.pathname === '/fs') return res.end((await readFile(new URL(import.meta.url))).length > 0 ? 'fs ok' : 'empty')
  if (url.pathname === '/slow') {
    console.log('slow started')
    await new Promise((ok) => setTimeout(ok, 500))
    return res.end('slow done')
  }
  if (url.pathname === '/close') return server.close((error) => res.end(error ? error.message : 'closed'))
  res.statusCode = 404
  res.end()
})
server.on('upgrade', (req, socket, head) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n')
  if (head.length) socket.write(head)
  socket.pipe(socket)
})
server.on('close', () => console.log('closed'))
server.listen(3000, () => console.log(`ready ${server.address().port} ${server.listening}`))
