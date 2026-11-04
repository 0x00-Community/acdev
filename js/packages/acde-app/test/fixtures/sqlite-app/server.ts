import { Database } from 'bun:sqlite'

const db = new Database('notes.db')
db.run('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)')
const insert = db.query('INSERT INTO notes (text) VALUES ($text)')
const addMany = db.transaction((texts: string[]) => {
  for (const text of texts) insert.run({ $text: text })
  return texts.length
})

export default {
  port: 3000,
  async fetch(req: Request, server: { upgrade(req: Request, options?: { data?: unknown }): boolean }) {
    const url = new URL(req.url)
    switch (url.pathname) {
      case '/api/notes':
        if (req.method === 'POST') {
          const { text } = (await req.json()) as { text: string }
          const { lastInsertRowid } = insert.run({ $text: text })
          return Response.json({ id: Number(lastInsertRowid) }, { status: 201 })
        }
        return Response.json(db.query('SELECT id, text FROM notes ORDER BY id').all())
      case '/api/many':
        return Response.json({ added: addMany(((await req.json()) as { texts: string[] }).texts) })
      case '/api/env':
        return Response.json({ port: process.env.PORT, app: process.env.ACDE_APP_ID, data: process.env.ACDE_APP_DATA, home: process.env.HOME ?? null })
      case '/api/file':
        await Bun.write('hello.txt', `hi from ${process.env.ACDE_APP_ID}`)
        return new Response(Bun.file('hello.txt'))
      case '/api/outside':
        try {
          return new Response(String((await fetch('http://example.com/')).status))
        } catch (error) {
          return new Response(String(error), { status: 502 })
        }
      case '/api/events':
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 3; i++) {
                controller.enqueue(new TextEncoder().encode(`data: ${i}\n\n`))
                await Bun.sleep(30)
              }
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      case '/api/upload': {
        let size = 0
        for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) size += chunk.length
        return Response.json({ size })
      }
      case '/ws':
        if (server.upgrade(req, { data: { since: Date.now() } })) return undefined
        return new Response('expected a WebSocket', { status: 426 })
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws: { send(text: string): void }) {
      ws.send('hello')
    },
    message(ws: { send(text: string): void }, message: string | Uint8Array) {
      ws.send(`echo ${typeof message === 'string' ? message : `${message.length} bytes`}`)
    },
  },
}
