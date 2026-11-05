export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (url.pathname === '/api/hello') return Response.json({ hello: '{{label}}', at: new Date().toISOString() })
    return new Response('not found', { status: 404 })
  },
}
