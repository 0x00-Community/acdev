import { createServer } from 'node:net'
const server = createServer((socket) => {
  socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 10\r\nconnection: close\r\n\r\nnet-server'))
})
server.listen(4000, 511, () => console.log('ready'))
