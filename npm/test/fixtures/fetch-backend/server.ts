import { greeting } from './lib.ts'

export default {
  async fetch(request: Request, server: { upgrade(request: Request): boolean }): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/api/hello':
        return Response.json({ hello: greeting(), url: request.url, method: request.method, runtime: process.versions.bun ? 'bun' : 'node', port: process.env.PORT ?? null })
      case '/api/echo':
        return new Response(request.body, { status: 201, headers: { 'content-type': request.headers.get('content-type') ?? 'application/octet-stream', 'x-seen': request.headers.get('x-test') ?? '' } })
      case '/api/cookies': {
        const headers = new Headers()
        headers.append('set-cookie', 'a=1; Path=/')
        headers.append('set-cookie', 'b=2; Path=/')
        return new Response('cookies', { headers })
      }
      case '/api/stream':
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 3; i++) {
                controller.enqueue(new TextEncoder().encode(`data: ${i}\n\n`))
                await new Promise((resolve) => setTimeout(resolve, 30))
              }
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      case '/api/upgrade':
        return new Response(String(server.upgrade(request)), { status: 426 })
      case '/api/throw':
        throw new Error('boom')
    }
    return new Response('not found', { status: 404 })
  },
}
