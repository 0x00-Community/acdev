export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (url.pathname === '/api/hello') return Response.json({ hello: 'hi', pid: process.pid })
    if (url.pathname === '/api/crash') {
      console.error('hello-backend crashes on purpose')
      process.exit(3)
    }
    return new Response('not found', { status: 404 })
  },
}
