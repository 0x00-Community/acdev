const server = Bun.serve({ port: process.env.PORT, fetch: () => new Response('env-port') })
console.log(`ready ${server.port}`)

export {}
