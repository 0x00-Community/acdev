import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('acde app build', () => {
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
        assets: { '/app/hello-app/backend/': ['backend'], '/app/hello-app/': ['assets'] },
      },
    })
  })

  test('assets/index.html refers only to /app/<id>/ files that exist', () => {
    const html = readFileSync(join(out, 'assets/index.html'), 'utf8')
    const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!)
    expect(urls.length).toBeGreaterThanOrEqual(4)
    for (const url of urls) {
      expect(url).toStartWith('/app/hello-app/')
      expect(existsSync(join(out, 'assets', url.slice('/app/hello-app/'.length)))).toBe(true)
    }
    expect(html).not.toContain('/src/')
  })

  test('chunk URLs in the scripts are under /app/<id>/ too', () => {
    for (const file of readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'))) {
      const js = readFileSync(join(out, 'assets', file), 'utf8')
      for (const [, url] of js.matchAll(/"(\/[^"]+\.(?:js|css))"/g)) {
        expect(url!).toStartWith('/app/hello-app/')
        expect(existsSync(join(out, 'assets', url!.slice('/app/hello-app/'.length)))).toBe(true)
      }
      expect(js).not.toContain('import.meta.env')
    }
  })

  test('public/ is copied as it is', () => {
    expect(existsSync(join(out, 'assets/favicon.svg'))).toBe(true)
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

describe('acde app install / run', () => {
  test('install copies the package to $XDG_DATA_HOME/acde/packages/<id>, replacing an older copy', async () => {
    const data = tmp()
    const out = join(tmp(), 'out')
    const dest = join(data, 'acde/packages/hello-app')
    expect((await cli(['install', '--out', out], APP, { XDG_DATA_HOME: data })).code).toBe(0)
    expect(existsSync(join(dest, 'package.json'))).toBe(true)
    writeFileSync(join(dest, 'stale'), '')
    expect((await cli(['install', `--out=${out}`], APP, { XDG_DATA_HOME: data })).code).toBe(0)
    expect(existsSync(join(dest, 'stale'))).toBe(false)
    expect(existsSync(join(dest, 'assets/index.html'))).toBe(true)
  })

  test('run without acde on PATH installs and fails', async () => {
    const data = tmp()
    const result = await cli(['run', '--out', join(tmp(), 'out')], APP, { XDG_DATA_HOME: data, PATH: tmp() })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no acde (ACDE_BIN, PATH)')
    expect(existsSync(join(data, 'acde/packages/hello-app/package.json'))).toBe(true)
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
    expect(built.acde).toEqual({ apps: [{ id: 'hello', label: 'Hi', icon: 'apps', entry: '/app/hello/index.html', capabilities: {} }], assets: { '/app/hello/': ['assets'] } })
    expect(existsSync(join(data, 'acde/packages/hello/assets/index.html'))).toBe(true)
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
    expect(built.acde.assets).toEqual({ '/desktop/mine/': ['desktop'], '/app/notes/': ['apps/notes/assets'] })
    for (const file of ['desktop/index.html', 'services/clock.js', 'apps/notes/assets/notes.html']) expect(existsSync(join(out, file))).toBe(true)
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

  test('check: a missing entry, a wrong type', async () => {
    const dir = join(tmp(), 'bad')
    expect((await cli(['new', dir], tmp())).code).toBe(0)
    rmSync(join(dir, 'index.html'))
    expect((await cli(['check'], dir)).stderr).toContain('no index.html (entry in acde.config.jsonc)')
    writeFileSync(join(dir, 'acde.config.jsonc'), '{ "type": "widget" }')
    expect((await cli(['check'], dir)).stderr).toContain('"type" is "app" (a window app) or "desktop"')
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
    const result = await cli(['deploy'], APP)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('usage: acde app')
  })

  test('ids from package names', () => {
    expect(appId('@scope/My_App')).toBe('my-app')
    expect(appId('notes')).toBe('notes')
    expect(appId('@x/--')).toBeNull()
  })
})
