import { createServer } from 'node:http'
const server = createServer((_req, res) => res.end('listen-zero'))
server.listen({ port: 0, host: '::' }, () => console.log('ready'))
