import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppPackage } from '../src/package.ts'
import { appId } from '../src/sockets.ts'
import { cleanup, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const APP = join(import.meta.dir, 'fixtures/app')

async function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: env(extra), stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

afterAll(cleanup)

async function answer(out: string, path: string): Promise<string> {
  const sockets = tmp()
  const child = Bun.spawn([process.execPath, '--preload', join(out, 'backend/acde-listen.js'), join(out, 'backend/server.js')], {
    env: env({ ACDE_APP_SOCKETS: sockets }),
    stdout: 'ignore',
    stderr: 'inherit',
  })
  try {
    const socket = join(sockets, '3000.sock')
    for (let i = 0; i < 200 && !existsSync(socket); i++) await Bun.sleep(25)
    return await (await fetch(`http://localhost${path}`, { unix: socket })).text()
  } finally {
    child.kill()
    await child.exited
  }
}

describe('acde build', () => {
  const out = join(tmp(), 'out')
  let built: Awaited<ReturnType<typeof cli>>
  beforeAll(async () => {
    built = await cli(['build', '--out', out], APP)
  })

  test('exits 0', () => {
    expect(built.stderr).toBe('')
    expect(built.code).toBe(0)
  })

  test('writes the manifest', () => {
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toEqual({
      name: '@example/Hello_App',
      version: '1.2.3',
      private: true,
      acde: {
        apps: [
          {
            id: 'hello-app',
            label: 'Hello',
            icon: 'app',
            entry: '/app/hello-app/index.html',
            capabilities: { fs: true },
            backend: { entry: '/app/hello-app/backend/server.js', port: 3000 },
          },
        ],
        assets: { '/app/hello-app/backend/': ['backend'], '/app/hello-app/': ['web'] },
      },
    })
  })

  test('web/index.html refers only to /app/<id>/ files that exist', () => {
    const html = readFileSync(join(out, 'web/index.html'), 'utf8')
    const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!)
    expect(urls.length).toBeGreaterThanOrEqual(4)
    for (const url of urls) {
      expect(url).toStartWith('/app/hello-app/')
      expect(existsSync(join(out, 'web', url.slice('/app/hello-app/'.length)))).toBe(true)
    }
    expect(html).not.toContain('/src/')
  })

  test('chunk URLs in the scripts are under /app/<id>/ too', () => {
    for (const file of readdirSync(join(out, 'web')).filter((f) => f.endsWith('.js'))) {
      const js = readFileSync(join(out, 'web', file), 'utf8')
      for (const [, url] of js.matchAll(/"(\/[^"]+\.(?:js|css))"/g)) {
        expect(url!).toStartWith('/app/hello-app/')
        expect(existsSync(join(out, 'web', url!.slice('/app/hello-app/'.length)))).toBe(true)
      }
      expect(js).not.toContain('import.meta.env')
    }
  })

  test('public/ is copied as it is', () => {
    expect(existsSync(join(out, 'web/favicon.svg'))).toBe(true)
    expect(existsSync(join(out, 'web/fonts/fixture.woff2'))).toBe(true)
  })

  test('CSS url(/...) into public/ stays that URL (the app directory is also at /)', () => {
    const css = readdirSync(join(out, 'web')).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'web', f), 'utf8')).join('\n')
    expect(css).toContain('url(/fonts/fixture.woff2)')
  })

  test('backend/server.js is one ES module for Bun, the preload beside it', () => {
    expect(readFileSync(join(out, 'backend/server.js'), 'utf8')).toContain('Bun.serve(')
    expect(readFileSync(join(out, 'backend/acde-listen.js'), 'utf8')).toContain('acde.listen')
    expect(readdirSync(join(out, 'backend')).sort()).toEqual(['acde-listen.js', 'server.js'])
  })

  test('the built backend under its preload, as acde runs it, answers on <port>.sock', async () => {
    expect(await answer(out, '/api/hello')).toBe('hello from the backend')
  })
})

describe('backends', () => {
  const SQLITE_APP = join(import.meta.dir, 'fixtures/sqlite-app')

  test('bun:sqlite stays an import; Bun.file / Bun.write pass', async () => {
    const out = join(tmp(), 'out')
    const built = await cli(['build', '--out', out], SQLITE_APP)
    expect(built.stderr).toBe('')
    expect(built.code).toBe(0)
    const js = readFileSync(join(out, 'backend/server.js'), 'utf8')
    expect(js).toMatch(/from\s*["']bun:sqlite["']/)
    expect(js).toContain('process.env.PORT')
    const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(manifest.acde.apps[0].backend).toEqual({ entry: '/app/notes/backend/server.js', port: 3000 })
  })

  test("Node's modules and npm-style servers build: node:http stays an import", async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), '{"name": "node-app"}')
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>node</title><p>node</p>')
    writeFileSync(join(dir, 'server.js'), "import http from 'node:http'\nhttp.createServer((req, res) => res.end('hi')).listen(3000)\n")
    const out = join(dir, '.acde')
    const built = await cli(['build', '--out', out], dir)
    expect(built.stderr).toBe('')
    expect(built.code).toBe(0)
    expect(readFileSync(join(out, 'backend/server.js'), 'utf8')).toMatch(/from\s*["'](node:)?http["']/)
    expect(await answer(out, '/')).toBe('hi')
  })
})

describe('acde install / dev', () => {
  test('install copies the package to $XDG_DATA_HOME/acde/packages/<id>, replacing an older copy', async () => {
    const data = tmp()
    const out = join(tmp(), 'out')
    const dest = join(data, 'acde/packages/hello-app')
    expect((await cli(['install', '--out', out], APP, { XDG_DATA_HOME: data })).code).toBe(0)
    expect(existsSync(join(dest, 'package.json'))).toBe(true)
    writeFileSync(join(dest, 'stale'), '')
    expect((await cli(['install', `--out=${out}`], APP, { XDG_DATA_HOME: data })).code).toBe(0)
    expect(existsSync(join(dest, 'stale'))).toBe(false)
    expect(existsSync(join(dest, 'web/index.html'))).toBe(true)
  })

  test('dev without acdert on PATH fails before building', async () => {
    const out = join(tmp(), 'out')
    const result = await cli(['dev', '--out', out], APP, { PATH: tmp() })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no acdert (ACDERT, PATH)')
    expect(existsSync(out)).toBe(false)
  })
})

describe('acde.config.jsonc', () => {
  test('new app: builds a window app from index.html', async () => {
    const data = tmp()
    const dir = join(tmp(), 'hello')
    expect((await cli(['new', dir, '--label', 'Hi'], tmp())).code).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).devDependencies['@dopame/acde-api']).toStartWith('file:')
    expect((await cli(['check'], dir)).stdout).toContain('app (acde.config.jsonc)')
    expect((await cli(['install'], dir, { XDG_DATA_HOME: data })).code).toBe(0)
    const built = JSON.parse(readFileSync(join(data, 'acde/packages/hello/package.json'), 'utf8'))
    expect(built.acde).toEqual({ apps: [{ id: 'hello', label: 'Hi', icon: 'apps', entry: '/app/hello/index.html', capabilities: {} }], assets: { '/app/hello/': ['web'] } })
    expect(existsSync(join(data, 'acde/packages/hello/web/index.html'))).toBe(true)
  })

  test('new --desktop: builds a desktop, its services and its apps', async () => {
    const dir = join(tmp(), 'mine')
    expect((await cli(['new', dir, '--desktop', '--label', '我的桌面'], tmp())).code).toBe(0)
    writeFileSync(join(dir, 'clock.js'), 'export default () => ({ methods: { now: () => Date.now() } })\n')
    writeFileSync(join(dir, 'notes.html'), '<!doctype html><title>Notes</title><p>notes</p>\n')
    const config = readFileSync(join(dir, 'acde.config.jsonc'), 'utf8')
    writeFileSync(join(dir, 'acde.config.jsonc'), config.replace('"services": {}', '"services": { "clock": "clock.js" }').replace('"apps": []', '"apps": [{ "id": "notes", "label": "Notes", "entry": "notes.html", "backend": false }]'))
    const out = join(tmp(), 'out')
    const result = await cli(['build', '--out', out], dir)
    expect(result.stderr).toBe('')
    const built = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(built.acde.desktops).toEqual([{ id: 'mine', name: '我的桌面', entry: 'desktop/index.html', services: ['clock'] }])
    expect(built.acde.services).toEqual([{ name: 'clock', module: 'services/clock.js' }])
    expect(built.acde.apps).toEqual([{ id: 'notes', label: 'Notes', icon: 'app', entry: '/app/notes/notes.html' }])
    expect(built.acde.assets).toEqual({ '/desktop/mine/': ['desktop'], '/app/notes/': ['apps/notes/web'] })
    for (const file of ['desktop/index.html', 'services/clock.js', 'apps/notes/web/notes.html']) expect(existsSync(join(out, file))).toBe(true)
    const scripts = readdirSync(join(out, 'desktop')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'desktop', f), 'utf8'))
    expect(scripts.some((text) => /from\s*"acde:apps"/.test(text))).toBe(true)
  })

  test('a hand-written package (package.json acde.apps) installs as a link', async () => {
    const data = tmp()
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), 'export default { mount() { return () => {} } }\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'by-hand', acde: { apps: [{ id: 'by-hand', label: 'x', icon: 'apps', entry: '/ui/app.js' }], assets: { '/ui/': ['ui'] } } }))
    expect((await cli(['install'], dir, { XDG_DATA_HOME: data })).code).toBe(0)
    expect(readlinkSync(join(data, 'acde/packages/by-hand'))).toBe(realpathSync(dir))
    rmSync(join(dir, 'ui/app.js'))
    const result = await cli(['check'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is in no assets directory')
  })

  test('new . in a fresh git checkout (only .git there)', async () => {
    const dir = tmp()
    mkdirSync(join(dir, '.git'))
    expect((await cli(['new', '.', '--id', 'pomodoro'], dir)).code).toBe(0)
    writeFileSync(join(dir, 'stray'), '')
    expect((await cli(['new', '.', '--id', 'again'], dir)).stderr).toContain('is not empty')
  })

  test('new --template html --backend: the page answers from server.ts', async () => {
    const dir = join(tmp(), 'with-api')
    const made = await cli(['new', dir, '--template', 'html', '--backend', '--label', 'API'], tmp())
    expect(made.code).toBe(0)
    expect(made.stdout).toContain('next: cd ')
    const out = join(tmp(), 'out')
    expect((await cli(['build', '--out', out], dir)).code).toBe(0)
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).acde.apps[0].backend).toEqual({ entry: '/app/with-api/backend/server.js', port: 3000 })
    expect(JSON.parse(await answer(out, '/api/hello')).hello).toBe('API')
  })

  test('a framework project gets acde.config.jsonc, the SDK and .acde/ ignored', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'made-by-vite', devDependencies: { vite: '^7.0.0' } }))
    writeFileSync(join(dir, '.gitignore'), 'node_modules')
    AppPackage.adopt(dir, 'made-by-vite', 'Vite App', 'React')
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.devDependencies)).toEqual(['vite', '@dopame/acde-api'])
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.acde/\n')
    expect(readFileSync(join(dir, 'acde.config.jsonc'), 'utf8')).toContain('"label": "Vite App"')
    AppPackage.adopt(dir, 'made-by-vite', 'Vite App', 'React')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.acde/\n')
  })

  test('new: no directory and no terminal, or a template that does not exist', async () => {
    expect((await cli(['new'], tmp())).stderr).toContain('new: a directory')
    expect((await cli(['new', 'x', '--template', 'angular'], tmp())).stderr).toContain('template "angular": one of html, react')
  })

  test('check: a missing entry, a wrong type', async () => {
    const dir = join(tmp(), 'bad')
    expect((await cli(['new', dir], tmp())).code).toBe(0)
    rmSync(join(dir, 'index.html'))
    expect((await cli(['check'], dir)).stderr).toContain('no index.html (entry in acde.config.jsonc)')
    writeFileSync(join(dir, 'acde.config.jsonc'), '{ "type": "widget" }')
    expect((await cli(['check'], dir)).stderr).toContain('"type" is "app" (a window app) or "desktop"')
  })
})

describe('public/', () => {
  function project(files: Record<string, string | Buffer>): string {
    const dir = tmp()
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), data)
    }
    return dir
  }

  test('CSS url(/...) that is nowhere: the error names the file and public/', async () => {
    const dir = project({
      'package.json': '{"name": "lost-font"}',
      'index.html': '<!doctype html><link rel="stylesheet" href="./style.css"><p>x</p>',
      'style.css': "@font-face { font-family: X; src: url('/fonts/gone.woff2'); }",
    })
    const result = await cli(['build', '--out', join(dir, '.acde')], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('/fonts/gone.woff2 in style.css: there is no public/fonts/gone.woff2')
  })

  test('an HTML reference to /x that is nowhere names public/ too', async () => {
    const dir = project({ 'package.json': '{"name": "lost-icon"}', 'index.html': '<!doctype html><link rel="icon" href="/gone.svg"><p>x</p>' })
    const result = await cli(['build', '--out', join(dir, '.acde')], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('/gone.svg in index.html: there is no public/gone.svg')
  })

  test('a desktop page and its apps: CSS url(/...) into public/ is bundled (no / mount there)', async () => {
    const dir = project({
      'acde.config.jsonc': JSON.stringify({ type: 'desktop', id: 'deck', apps: [{ id: 'cards', label: 'Cards', entry: 'cards.html', backend: false }] }),
      'index.html': '<!doctype html><link rel="stylesheet" href="./desk.css"><p>desk</p>',
      'desk.css': 'body { background: url(/wall.svg); }',
      'cards.html': '<!doctype html><link rel="stylesheet" href="./desk.css"><p>cards</p>',
      'public/wall.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
    const out = join(dir, '.acde')
    const result = await cli(['build', '--out', out], dir)
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const css = (web: string) => readdirSync(join(out, web)).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, web, f), 'utf8')).join('')
    for (const [web, prefix] of [['desktop', '/desktop/deck/'], ['apps/cards/web', '/app/cards/']] as const) {
      expect(css(web)).not.toContain('url(/wall.svg)')
      expect(css(web)).toMatch(new RegExp(`url\\((?:data:image/svg|${prefix}wall-)`))
    }
  })
})

describe('mistakes', () => {
  test('no index.html', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), '{"name": "empty"}')
    const result = await cli(['build', '--out', join(dir, '.acde')], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no index.html')
  })

  test('unknown command', async () => {
    const result = await cli(['frobnicate'], APP)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('usage: acde <command>')
  })

  test('ids from package names', () => {
    expect(appId('@scope/My_App')).toBe('my-app')
    expect(appId('notes')).toBe('notes')
    expect(appId('@x/--')).toBeNull()
  })
})
