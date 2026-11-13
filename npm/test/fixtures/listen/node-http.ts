import { createServer } from 'node:http'
const server = createServer((req, res) => res.end(`node-http ${req.url}`))
server.listen(3000, '127.0.0.1', () => {
  const address = server.address()
  console.log(`ready ${typeof address === 'object' ? address?.port : address}`)
})
