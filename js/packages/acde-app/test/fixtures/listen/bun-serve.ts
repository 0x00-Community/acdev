const server = Bun.serve({
  port: 3000,
  hostname: '0.0.0.0',
  fetch: (req) => new Response(`bun-serve ${new URL(req.url).pathname}`),
})
console.log(`ready ${server.port} ${server.url}`)

export {}
