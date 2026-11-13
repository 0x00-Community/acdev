import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOG = process.env['FAKE_BROWSER_LOG']!
const IDLE_MS = Number(process.env['FAKE_BROWSER_IDLE_MS'] ?? 15_000)
const record = (entry: object) => appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
const argv = process.argv.slice(2)
const profile = argv.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
record({ started: argv, pid: process.pid })
if (!profile) process.exit(2)
const file = join(profile, 'DevToolsActivePort')

const targets: { targetId: string; type: string; url: string }[] = []
let idle: ReturnType<typeof setTimeout>
const quit = () => {
  rmSync(file, { force: true })
  process.exit(0)
}
const later = () => {
  clearTimeout(idle)
  idle = setTimeout(quit, IDLE_MS)
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname
    if (path === '/json/version') return Response.json({ Browser: 'Fake/1.0' })
    if (path === '/devtools/browser/fake' && server.upgrade(request)) return undefined
    return new Response('not found', { status: 404 })
  },
  websocket: {
    message(socket, data) {
      const message = JSON.parse(String(data)) as { id: number; method: string; params?: { url?: string } }
      record({ method: message.method, params: message.params })
      let result: object = {}
      if (message.method === 'Target.createTarget') {
        const targetId = `fake-target-${targets.length + 1}`
        targets.push({ targetId, type: 'page', url: message.params?.url ?? '' })
        result = { targetId }
      } else if (message.method === 'Target.getTargets') result = { targetInfos: targets }
      socket.send(JSON.stringify({ id: message.id, result }))
      later()
    },
  },
})
writeFileSync(file, `${server.port}\n/devtools/browser/fake\n`)
later()
process.on('SIGTERM', quit)
