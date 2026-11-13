import { createServer } from 'node:http'

const bun = Bun.serve({
  port: 3000,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/slow') {
      console.log('slow started')
      await Bun.sleep(500)
      return new Response('slow done')
    }
    if (path === '/stop') {
      setTimeout(() => {
        void bun.stop()
        node.close()
      }, 10)
      return new Response('stopping')
    }
    return new Response('bun')
  },
})
const node = createServer((_req, res) => res.end('node')).listen(3001, () => console.log('ready'))
node.on('close', () => console.log('node closed'))
