Bun.serve({
  port: 3000,
  routes: {
    '/api/hello': () => new Response('hello from the backend'),
  },
  fetch: () => new Response('not found', { status: 404 }),
})
