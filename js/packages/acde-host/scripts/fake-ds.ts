import { createHmac } from 'node:crypto'
import { createServer, request, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { port: { type: 'string', default: '8085' }, socket: { type: 'string' } } })
const port = Number(values.port)
const socket = values.socket ?? join(process.env['XDG_RUNTIME_DIR'] ?? '/tmp', 'acde', 'office.sock')
const secret = process.env['AGENTRT_OFFICE_JWT_SECRET'] ?? ''
if (secret.length < 32) throw new Error('AGENTRT_OFFICE_JWT_SECRET (≥ 32 characters) is required')

type Json = Record<string, any>

class FakeDs {
  readonly sessions = new Map<string, { config: Json; original: Buffer }>()
  readonly cache = new Map<string, Buffer>()

  static jwt(payload: Json): string {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, exp: Math.floor(Date.now() / 1000) + 300 })}`
    return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
  }

  static bridge(method: string, url: string, body?: Json): Promise<{ status: number; body: Buffer }> {
    const { pathname, search } = new URL(url)
    const text = body ? JSON.stringify(body) : undefined
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, method, path: pathname + search, headers: { Host: '127.0.0.1:7979', Authorization: `Bearer ${FakeDs.jwt({ payload: body ?? {} })}`, ...(text ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end(text)
    })
  }

  static edited(zip: Buffer): Buffer {
    const at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (at < 0) throw new Error('not a zip')
    const comment = Buffer.from(`edited by fake-ds at ${new Date().toISOString()}`)
    const head = Buffer.from(zip.subarray(0, at + 22))
    head.writeUInt16LE(comment.length, at + 20)
    return Buffer.concat([head, comment])
  }

  async open(config: Json): Promise<void> {
    const key = String(config.document.key)
    const file = await FakeDs.bridge('GET', config.document.url)
    if (file.status !== 200) throw new Error(`bridge refused the document: ${file.status} ${file.body.toString().slice(0, 200)}`)
    this.sessions.set(key, { config, original: file.body })
    console.log(`fake-ds: opened ${config.document.title} (${file.body.length} bytes, key ${key})`)
  }

  async forcesave(key: string): Promise<void> {
    const session = this.sessions.get(key)!
    const name = `${key}/output.${session.config.document.fileType}`
    this.cache.set(name, FakeDs.edited(session.original))
    const body = { key, status: 6, url: `http://127.0.0.1:${port}/cache/files/${name}`, users: ['fake'], forcesavetype: 0, userdata: 'agentrt-office' }
    const answer = await FakeDs.bridge('POST', session.config.editorConfig.callbackUrl, body)
    console.log(`fake-ds: forcesave callback for ${key}: ${answer.status} ${answer.body.toString().slice(0, 120)}`)
  }

  readonly api = `window.DocsAPI = { DocEditor: function (id, config) {
  var el = document.getElementById(id);
  el.innerHTML = '<div style="font:16px sans-serif;padding:24px"><h2 style="margin:0 0 8px">Fake Document Server</h2><p></p></div>';
  el.querySelector('p').textContent = config.document.title + ' (' + config.editorConfig.mode + ')';
  fetch('http://127.0.0.1:${port}/fake/open', { method: 'POST', body: JSON.stringify(config) });
  this.destroyEditor = function () {};
} };`
}

const ds = new FakeDs()
const read = (req: IncomingMessage) => new Promise<string>((done) => { let text = ''; req.on('data', (c) => (text += c)); req.on('end', () => done(text)) })
createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const send = (status: number, body: string | Buffer, type = 'application/json') => res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }).end(body)
  try {
    if (path === '/healthcheck') return send(200, 'true', 'text/plain')
    if (path === '/web-apps/apps/api/documents/api.js') return send(200, ds.api, 'text/javascript')
    if (path === '/fake/open' && req.method === 'POST') {
      await ds.open(JSON.parse(await read(req)))
      return send(200, '{}')
    }
    if (path === '/command' && req.method === 'POST') {
      const body = JSON.parse(await read(req)) as Json
      if (body.c === 'version') return send(200, JSON.stringify({ error: 0, version: 'fake-9.4.0' }))
      if (body.c === 'forcesave') {
        if (!ds.sessions.has(body.key)) return send(200, JSON.stringify({ error: 1 }))
        send(200, JSON.stringify({ error: 0, key: body.key }))
        setTimeout(() => void ds.forcesave(body.key).catch((e) => console.error('fake-ds:', e)), 300)
        return
      }
      return send(200, JSON.stringify({ error: 5 }))
    }
    if (path.startsWith('/cache/files/')) {
      const file = ds.cache.get(path.slice('/cache/files/'.length))
      return file ? send(200, file, 'application/octet-stream') : send(404, '{}')
    }
    send(404, '{}')
  } catch (error) {
    console.error('fake-ds:', error)
    send(500, JSON.stringify({ error: String(error) }))
  }
}).listen(port, '127.0.0.1', () => console.log(`fake-ds: http://127.0.0.1:${port}, bridge ${socket}`))
