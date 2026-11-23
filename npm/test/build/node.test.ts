import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Subprocess } from 'bun'
import { which } from '../../launcher.mjs'
import { BunBundler } from '../../src/bundler.ts'
import { Runtime } from '../../src/runtime.ts'
import { cleanup, collect, env, inetSockets, line, skipping, tmp, WINDOWS } from '../helpers.ts'

const FIXTURE = join(import.meta.dir, '../fixtures/fetch-backend')

function realNode(): string | null {
  const candidates = [process.env['ACDEV_TEST_NODE'], which('node')].filter((c): c is string => !!c)
  for (const node of candidates) {
    const probe = Bun.spawnSync([node, '-p', 'process.versions.bun ? "bun" : process.versions.node'])
    const version = probe.stdout.toString().trim()
    if (probe.exitCode === 0 && /^\d+\./.test(version) && Number.parseInt(version, 10) >= 22) return node
  }
  return null
}

const UNIX_SOCKETS = 'Node.js backends on Unix sockets: Windows support is tracked in acdert#4'
const NODE = skipping(WINDOWS, UNIX_SOCKETS) ? null : realNode()
if (!WINDOWS && !NODE) console.warn('no Node.js >= 22; set ACDEV_TEST_NODE or put a real node first on PATH')

const children: Subprocess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})
afterAll(cleanup)

async function build(entry: string): Promise<string> {
  const out = join(tmp(), 'backend')
  const bundler = new BunBundler()
  await bundler.backend({ entry, out, dir: FIXTURE, splitting: false })
  await bundler.preload(out)
  return out
}

function run(argv: string[], extra: Record<string, string>): Subprocess<'ignore', 'pipe', 'pipe'> {
  const child = Bun.spawn(argv, { env: env(extra), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  children.push(child)
  return child
}

function underNode(dir: string, entry: string): string[] {
  return [NODE!, '--import', pathToFileURL(join(dir, 'acde-listen.js')).href, join(dir, entry)]
}

async function waitFor(socket: string, child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(socket); i++) {
    if (child.exitCode !== null) {
      throw new Error(`exited ${child.exitCode}: ${await new Response(child.stderr).text()}`)
    }
    await Bun.sleep(25)
  }
}

describe.skipIf(!NODE)('a built Unix-socket backend under node --import acde-listen.js', () => {
  let out: string
  let sockets: string
  let socket: string
  let child: Subprocess<'ignore', 'pipe', 'pipe'>
  beforeAll(async () => {
    out = await build(join(FIXTURE, 'server.ts'))
  })

  const ask = (path: string, init: RequestInit = {}) => fetch(`http://acde.local${path}`, { ...init, unix: socket })

  async function start(extra: Record<string, string> = {}): Promise<void> {
    sockets = join(tmp(), 'sockets')
    socket = join(sockets, `${extra['PORT'] ?? 3000}.sock`)
    child = run(underNode(out, 'server.js'), { ACDE_APP_SOCKETS: sockets, ...extra })
    await waitFor(socket, child)
  }

  test('export default {fetch} answers on <port>.sock, no TCP port', async () => {
    await start()
    const answer = await ask('/api/hello?x=1')
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toContain('application/json')
    expect(await answer.json()).toEqual({
      hello: 'from a fetch handler', url: 'http://acde.local/api/hello?x=1', method: 'GET', runtime: 'node',
      port: null,
    })
    const inet = inetSockets(child.pid)
    if (inet !== null) expect(inet).toEqual([])
  })

  test('$PORT picks the socket', async () => {
    await start({ PORT: '3456' })
    expect(((await (await ask('/api/hello')).json()) as { port: string }).port).toBe('3456')
  })

  test('request bodies stream in, headers both ways, status kept', async () => {
    await start()
    const body = 'x'.repeat(300_000)
    const headers = { 'content-type': 'text/plain', 'x-test': 'yes' }
    const answer = await ask('/api/echo', { method: 'POST', body, headers })
    expect(answer.status).toBe(201)
    expect(answer.headers.get('x-seen')).toBe('yes')
    expect(answer.headers.get('content-type')).toBe('text/plain')
    expect((await answer.text()).length).toBe(body.length)
  })

  test('several set-cookie headers stay several', async () => {
    await start()
    expect((await ask('/api/cookies')).headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  })

  test('a streamed response arrives in pieces', async () => {
    await start()
    const answer = await ask('/api/stream')
    expect(answer.headers.get('content-type')).toBe('text/event-stream')
    const reader = answer.body!.getReader()
    const pieces: string[] = []
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      pieces.push(new TextDecoder().decode(read.value))
    }
    expect(pieces.join('')).toBe('data: 0\n\ndata: 1\n\ndata: 2\n\n')
    expect(pieces.length).toBeGreaterThan(1)
  })

  test('HEAD has no body; a thrown error is a 500; upgrade says false; 404 passes through', async () => {
    await start()
    const head = await ask('/api/hello', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const thrown = await ask('/api/throw')
    expect(thrown.status).toBe(500)
    expect(await thrown.text()).toBe('Internal Server Error')
    expect(await (await ask('/api/upgrade')).text()).toBe('false')
    expect((await ask('/nope')).status).toBe(404)
  })
})

test('a built backend under bun --preload answers HTTP over a fresh socket', async () => {
  const out = await build(join(FIXTURE, 'server.ts'))
  const sockets = join(tmp(), 'sockets')
  const socket = join(sockets, '3000.sock')
  const argv = [process.execPath, '--preload', join(out, 'acde-listen.js'), join(out, 'server.js')]
  const child = run(argv, { ACDE_APP_SOCKETS: sockets })
  await waitFor(socket, child)
  const answer = await fetch('http://acde.local/api/hello', { unix: socket })
  expect(await answer.json()).toMatchObject({ hello: 'from a fetch handler', runtime: 'bun' })
})

describe.skipIf(!NODE)('the Unix-socket preload on Node.js', () => {
  test('node:http listen(4100, host) goes to 4100.sock', async () => {
    const out = await build(join(FIXTURE, 'http-server.js'))
    const sockets = join(tmp(), 'sockets')
    const child = run(underNode(out, 'server.js'), { ACDE_APP_SOCKETS: sockets })
    await line(child, 'ready')
    const answer = await fetch('http://acde.local/a?b=1', { unix: join(sockets, '4100.sock') })
    expect(await answer.text()).toBe('node-http /a?b=1')
  })

  test('acde-listen.js loads beside a CommonJS package.json too (no import / export in it)', async () => {
    const out = await build(join(FIXTURE, 'http-server.js'))
    const cjs = join(tmp(), 'cjs')
    mkdirSync(cjs)
    writeFileSync(join(cjs, 'package.json'), '{ "type": "commonjs" }')
    writeFileSync(join(cjs, 'acde-listen.js'), await Bun.file(join(out, 'acde-listen.js')).text())
    const server = "require('node:http').createServer((q, s) => s.end('cjs'))" +
      ".listen(4200, () => console.log('ready'))\n"
    writeFileSync(join(cjs, 'server.js'), server)
    const sockets = join(tmp(), 'sockets')
    const child = run(underNode(cjs, 'server.js'), { ACDE_APP_SOCKETS: sockets })
    await line(child, 'ready')
    expect(await (await fetch('http://acde.local/', { unix: join(sockets, '4200.sock') })).text()).toBe('cjs')
  })
})

describe('acdev build with Vite (as on Node.js; here ACDEV_BUNDLER=vite on bun, with acde\'s own vite)', () => {
  const CLI = join(import.meta.dir, '../../src/cli.ts')
  const MODULES = join(import.meta.dir, '../../node_modules')
  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000d4944415478da63f8cfc0f01f0005000201a1d1d1ff0000000049454e44ae426082',
    'hex',
  )

  function project(files: Record<string, string | Buffer>, modules = true): string {
    const dir = tmp()
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), data)
    }
    if (modules) symlinkSync(MODULES, join(dir, 'node_modules'), WINDOWS ? 'junction' : 'dir')
    return dir
  }

  async function build(dir: string, extra: Record<string, string> = {}) {
    const out = join(dir, '.acde')
    const ran = await collect([process.execPath, CLI, 'build', '--out', out], {
      cwd: dir, env: env({ ACDEV_BUNDLER: 'vite', ...extra }),
    })
    return { code: ran.code, stdout: ran.stdout, stderr: ran.stderr, out }
  }

  const files = (dir: string, ext: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith(ext)).map((f) => join(dir, f))
  const text = (dir: string, ext: string) => files(dir, ext).map((f) => readFileSync(f, 'utf8')).join('\n')

  test('the fixture app: /app/<id>/ URLs, public/ copied, CSS url(/x) into public/ kept, icon, ' +
    'backend and preload', async () => {
    const dir = tmp()
    cpSync(join(import.meta.dir, '../fixtures/app'), dir, { recursive: true })
    symlinkSync(MODULES, join(dir, 'node_modules'), WINDOWS ? 'junction' : 'dir')
    const result = await build(dir)
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const html = readFileSync(join(result.out, 'web/index.html'), 'utf8')
    const urls = [...html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]!)
    expect(urls.length).toBeGreaterThanOrEqual(3)
    for (const url of urls) {
      expect(url).toStartWith('/app/hello-app/')
      expect(existsSync(join(result.out, 'web', url.slice('/app/hello-app/'.length)))).toBe(true)
    }
    expect(html).not.toContain('/src/')
    expect(text(join(result.out, 'web'), '.css')).toContain('url(/fonts/fixture.woff2)')
    const decoded = html.replaceAll('&quot;', '"').replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    for (const [, url] of decoded.matchAll(/url\(\s*["']?([^"')\s]+)/g)) {
      if (url!.startsWith('data:')) continue
      expect(url!).toStartWith('/app/hello-app/')
      expect(existsSync(join(result.out, 'web', url!.slice('/app/hello-app/'.length)))).toBe(true)
    }
    const js = text(join(result.out, 'web'), '.js')
    expect(js).not.toContain('import.meta.env')
    expect(js).toContain('production')
    expect(existsSync(join(result.out, 'web/fonts/fixture.woff2'))).toBe(true)
    expect(readFileSync(join(result.out, 'web/icon.svg'), 'utf8'))
      .toBe(readFileSync(join(dir, 'src/logo.svg'), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(result.out, 'package.json'), 'utf8'))
    expect(manifest.acde.apps[0]).toMatchObject({
      id: 'hello-app',
      entry: '/app/hello-app/index.html',
      icon: '/app/hello-app/icon.svg',
      backend: { entry: '/app/hello-app/backend/server.js', port: 3000 },
    })
    expect(readdirSync(join(result.out, 'backend')).sort()).toEqual(['acde-listen.js', 'package.json', 'server.js'])
    expect(readFileSync(join(result.out, 'backend/acde-listen.js'), 'utf8')).not.toMatch(/^\s*(import|export)\b/m)
  })

  test('a desktop: the page, a service, an app; CSS url(/x) into public/ bundled there; ' +
    'acde:* stays an import', async () => {
    const dir = project({
      'acde.config.jsonc': `{ "type": "desktop", "id": "deck", "label": "Deck", // a comment
        "services": { "clock": "clock.ts" },
        "apps": [{ "id": "cards", "label": "Cards", "entry": "cards.html", "icon": "art/cards.png", "backend": false },
                 { "id": "mod", "entry": "src/mod.ts", "backend": false },], }`,
      'index.html':
        '<!doctype html><link rel="stylesheet" href="./desk.css">' +
        '<script type="module" src="./desk.ts"></script><p>desk</p>',
      'desk.ts': "import { apps } from 'acde:apps'\nconsole.log(apps)\n",
      'desk.css': 'body { background: url(/wall.svg); }',
      'cards.html':
        '<!doctype html><link rel="icon" href="/wall.svg"><link rel="stylesheet" href="./desk.css"><p>cards</p>',
      'clock.ts':
        'const late = () => import("./later.ts")\n' +
        'export default () => ({ methods: { now: () => Date.now(), late } })\n',
      'later.ts': 'export const later = 1\n',
      'src/mod.ts': 'export default { mount(root: HTMLElement) { root.textContent = "mod" } }\n',
      'public/wall.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">' +
        `<rect width="400" height="400" fill="#123456"/>${'<g/>'.repeat(2000)}</svg>`,
      'art/cards.png': PNG,
    })
    const result = await build(dir)
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const built = JSON.parse(readFileSync(join(result.out, 'package.json'), 'utf8'))
    expect(built.acde.desktops)
      .toEqual([{ id: 'deck', name: 'Deck', entry: 'desktop/index.html', services: ['clock'] }])
    expect(built.acde.services).toEqual([{ name: 'clock', module: 'services/clock.js' }])
    expect(built.acde.apps).toEqual([
      { id: 'cards', label: 'Cards', icon: '/app/cards/icon.png', entry: '/app/cards/cards.html' },
      { id: 'mod', label: 'mod', icon: 'application-x-executable', entry: '/app/mod/mod.js' },
    ])
    expect(built.acde.assets)
      .toEqual({ '/desktop/deck/': ['desktop'], '/app/cards/': ['apps/cards/web'], '/app/mod/': ['apps/mod/web'] })
    expect(readdirSync(join(result.out, 'services'))).toEqual(['clock.js'])
    expect(readFileSync(join(result.out, 'services/clock.js'), 'utf8')).toMatch(/export\s*\{[^}]*default/)
    expect(readFileSync(join(result.out, 'apps/mod/web/mod.js'), 'utf8')).toMatch(/export\s*\{[^}]*default/)
    expect(text(join(result.out, 'desktop'), '.js')).toMatch(/from\s*"acde:apps"/)
    expect(existsSync(join(result.out, 'desktop/wall.svg'))).toBe(true)
    expect(existsSync(join(result.out, 'apps/cards/web/wall.svg'))).toBe(false)
    for (const [web, prefix] of [['desktop', '/desktop/deck/'], ['apps/cards/web', '/app/cards/']] as const) {
      const css = text(join(result.out, web), '.css')
      expect(css).not.toContain('url(/wall.svg)')
      const url = /url\(([^)]*wall[^)]*)\)/.exec(css)?.[1]
      expect(url).toStartWith(prefix)
      expect(existsSync(join(result.out, web, url!.slice(prefix.length)))).toBe(true)
    }
    const cards = readFileSync(join(result.out, 'apps/cards/web/cards.html'), 'utf8')
    const icon = /rel="icon" href="([^"]*)"/.exec(cards)?.[1]
    expect(icon).toStartWith('/app/cards/')
    expect(existsSync(join(result.out, 'apps/cards/web', icon!.slice('/app/cards/'.length)))).toBe(true)
    expect(readFileSync(join(result.out, 'apps/cards/web/icon.png')).equals(PNG)).toBe(true)
  })

  test('a service importing acde:* fails the same under Bun and Vite, pointing to ctx.import', async () => {
    const dir = project({
      'acde.config.jsonc': '{ "type": "desktop", "id": "deck", "services": { "clock": "clock.ts" } }',
      'index.html': '<!doctype html><p>desk</p>',
      'clock.ts':
        "import { windows } from 'acde:windows'\nimport { tick } from './tick.ts'\n" +
        'export default () => ({ api: { clock: { now: () => [windows, tick()] } } })\n',
      'tick.ts': "export const tick = async () => (await import('acde:fs')).default\n",
    })
    const runs = [await build(dir, { ACDEV_BUNDLER: 'bun' }), await build(dir)]
    for (const ran of runs) {
      expect(ran.code).toBe(1)
      expect(ran.stderr).toContain('service clock: clock.ts imports acde:windows, tick.ts imports acde:fs: ' +
        "a service gets shell modules from ctx.import('acde:<name>'), listed in its modules in " +
        'acde.config.jsonc ("services": { "clock": { "module": "<file>", "modules": ["<name>"] } })')
      expect(existsSync(join(ran.out, 'services/clock.js'))).toBe(false)
    }
    expect(runs[0]!.stderr).toBe(runs[1]!.stderr)
  })

  test('an HTML page below the root lands as <name>.html, like Bun', async () => {
    const dir = project({
      'acde.config.jsonc': '{ "type": "app", "id": "deep", "entry": "pages/main/page.html" }',
      'pages/main/page.html': '<!doctype html><script type="module" src="./page.ts"></script>',
      'pages/main/page.ts': 'document.title = "deep"\n',
    })
    const result = await build(dir)
    expect(result.code).toBe(0)
    expect(existsSync(join(result.out, 'web/page.html'))).toBe(true)
    expect(existsSync(join(result.out, 'web/pages'))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(result.out, 'package.json'), 'utf8'))
    expect(manifest.acde.apps[0].entry).toBe('/app/deep/page.html')
  })

  test('references to /x that are nowhere name the file and public/', async () => {
    const css = await build(project({
      'package.json': '{"name": "lost-font"}',
      'index.html': '<!doctype html><link rel="stylesheet" href="./style.css"><p>x</p>',
      'style.css': "@font-face { font-family: X; src: url('/fonts/gone.woff2'); }",
    }))
    expect(css.code).toBe(1)
    expect(css.stderr).toContain(`/fonts/gone.woff2 in style.css: there is no ${join('public/fonts/gone.woff2')}`)
    const html = await build(project({
      'package.json': '{"name": "lost-icon"}',
      'index.html': '<!doctype html><link rel="icon" href="/gone.svg"><p>x</p>',
    }))
    expect(html.code).toBe(1)
    expect(html.stderr).toContain(`/gone.svg in index.html: there is no ${join('public/gone.svg')}`)
  })

  test('no vite in the project: says how to add it with its package manager', async () => {
    const dir = project(
      { 'package.json': '{"name": "plain"}', 'package-lock.json': '{}', 'index.html': '<!doctype html><p>x</p>' },
      false,
    )
    const result = await build(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('this project builds with Vite on Node.js: add it with npm add -D vite')
  })

  test('a Vite-built backend answers under the platform-supported preload runtime', async () => {
    const dir = project({
      'package.json': '{"name": "api", "type": "module"}',
      'index.html': '<!doctype html><p>x</p>',
    })
    cpSync(join(FIXTURE, 'server.ts'), join(dir, 'server.ts'))
    cpSync(join(FIXTURE, 'lib.ts'), join(dir, 'lib.ts'))
    const result = await build(dir)
    expect(result.code).toBe(0)
    const sockets = join(tmp(), 'sockets')
    const backend = join(result.out, 'backend')
    const preload = join(backend, 'acde-listen.js')
    const argv = NODE
      ? [NODE, '--import', pathToFileURL(preload).href]
      : [process.execPath, '--preload', preload]
    const child = run([...argv, join(backend, 'server.js')], { ACDE_APP_SOCKETS: sockets })
    await waitFor(join(sockets, '3000.sock'), child)
    const response = await fetch('http://acde.local/api/hello', { unix: join(sockets, '3000.sock') })
    const answer = (await response.json()) as { hello: string; runtime: string }
    expect(answer).toMatchObject({ hello: 'from a fetch handler', runtime: NODE ? 'node' : 'bun' })
  })
})
