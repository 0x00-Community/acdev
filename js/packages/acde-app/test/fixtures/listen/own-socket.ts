import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
const dir = process.env.ACDE_APP_SOCKETS!
mkdirSync(dir, { recursive: true })
Bun.serve({ unix: `${dir}/own-bun.sock`, fetch: () => new Response('own-bun') })
createServer((_req, res) => res.end('own-node')).listen(`${dir}/own-node.sock`, () => console.log('ready'))
