import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { AppPackage } from '../src/package.ts'
import { PackageManager } from '../src/pm.ts'
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
            icon: '/app/hello-app/icon.svg',
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

  test('an icon path is copied into web/ and the manifest names its URL', () => {
    expect(readFileSync(join(out, 'web/icon.svg'), 'utf8')).toBe(readFileSync(join(APP, 'src/logo.svg'), 'utf8'))
  })

  test('backend/server.js is one ES module, the preload beside it, a package.json that says ESM', () => {
    expect(readFileSync(join(out, 'backend/server.js'), 'utf8')).toContain('Bun.serve(')
    const preload = readFileSync(join(out, 'backend/acde-listen.js'), 'utf8')
    expect(preload).toContain('acde.listen')
    expect(preload).not.toMatch(/^\s*(import|export)\b/m)
    expect(readdirSync(join(out, 'backend')).sort()).toEqual(['acde-listen.js', 'package.json', 'server.js'])
    expect(JSON.parse(readFileSync(join(out, 'backend/package.json'), 'utf8'))).toEqual({ type: 'module' })
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

  test('dev with an ACDERT that does not exist fails before building', async () => {
    const out = join(tmp(), 'out')
    const result = await cli(['dev', '--out', out], APP, { ACDERT: join(tmp(), 'no-acdert') })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no-acdert: no such file')
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
    expect(built.acde).toEqual({ apps: [{ id: 'hello', label: 'Hi', icon: 'app', entry: '/app/hello/index.html', capabilities: {} }], assets: { '/app/hello/': ['web'] } })
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
    expect(pkg.devDependencies).toEqual({ vite: '^7.0.0', '@dopame/acde-api': AppPackage.wiring(dir).devDependencies['@dopame/acde-api'] })
    expect(pkg.scripts).toEqual({ 'acde:dev': 'acde dev', 'acde:build': 'acde build', 'acde:check': 'acde check' })
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

describe('a project made by acde from its checkout', () => {
  const API = realpathSync(join(import.meta.dir, '../../acdert/web/packages/acde-api'))
  const ROOT = realpathSync(join(import.meta.dir, '..'))

  function tools(names: readonly string[]): string {
    const bin = tmp()
    for (const name of names) {
      const found = name === 'bun' ? process.execPath : PackageManager.which(name)
      if (!found) throw new Error(`${name} is not on PATH`)
      symlinkSync(realpathSync(found), join(bin, name))
    }
    writeFileSync(join(bin, 'acde'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'bin/acde.mjs'))} "$@"\n`, { mode: 0o755 })
    return bin
  }

  async function run(argv: string[], cwd: string, path: string, extra: Record<string, string> = {}) {
    const child = Bun.spawn(argv, { cwd, env: env({ PATH: `${path}:/usr/bin:/bin`, npm_config_user_agent: '', ...extra }), stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, out: stdout + stderr }
  }

  test('the SDK is a relative file: path, scripts call acde from PATH, there is no acde dependency', () => {
    const dir = realpathSync(tmp())
    expect(AppPackage.INSTALLED).toBe(false)
    expect(AppPackage.wiring(dir)).toEqual({ devDependencies: { '@dopame/acde-api': `file:${relative(dir, API)}` }, command: 'acde' })
    expect(relative(dir, API)).toStartWith('..')
  })

  test('npm, pnpm and yarn projects get vite for the html and desktop templates, bun ones do not', () => {
    for (const [pm, vite] of [['bun', undefined], ['npm', AppPackage.VITE], ['pnpm', AppPackage.VITE], ['yarn', AppPackage.VITE]] as const) {
      for (const kind of AppPackage.KINDS) {
        const dir = join(tmp(), `${kind}-${pm}`)
        AppPackage.create(dir, kind, pm)
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        expect(pkg.devDependencies['vite']).toBe(vite)
        expect(pkg.devDependencies['acde']).toBeUndefined()
        expect(pkg.scripts).toEqual({ dev: 'acde dev', build: 'acde build', check: 'acde check' })
      }
    }
  })

  test('which package manager: the user agent, else the runtime acde runs on', () => {
    const saved = { agent: process.env['npm_config_user_agent'], runtime: process.env['ACDE_HOST_RUNTIME'] }
    try {
      process.env['npm_config_user_agent'] = 'pnpm/10.23.0 npm/? node/v24.0.0 darwin arm64'
      expect(PackageManager.invoking().name).toBe('pnpm')
      process.env['npm_config_user_agent'] = 'deno/2.7.12 npm/? deno/2.7.12 darwin arm64'
      delete process.env['ACDE_HOST_RUNTIME']
      expect(PackageManager.invoking().name).toBe('bun')
      process.env['ACDE_HOST_RUNTIME'] = 'node'
      expect(PackageManager.invoking().name).toBe('npm')
      expect(() => PackageManager.named('deno')).toThrow('one of bun, npm, pnpm, yarn')
      expect(PackageManager.named('pnpm').exec('create-vite@latest', ['x'])).toEqual([expect.stringMatching(/pnpm$/), 'dlx', 'create-vite@latest', 'x'])
      expect(PackageManager.named('bun').exec('sv@latest', ['create'])).toEqual([process.execPath, 'x', '--bun', 'sv@latest', 'create'])
    } finally {
      for (const [key, value] of [['npm_config_user_agent', saved.agent], ['ACDE_HOST_RUNTIME', saved.runtime]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('bun: bun install && bun run build with the checkout acde on PATH, no node there', async () => {
    const dir = join(tmp(), 'by-bun')
    expect((await cli(['new', dir, '--pm', 'bun', '--yes'], tmp())).code).toBe(0)
    const path = tools(['bun'])
    const installed = await run([process.execPath, 'install'], dir, path)
    expect(installed.code, installed.out).toBe(0)
    const built = await run([process.execPath, 'run', 'build'], dir, path)
    expect(built.out).toContain('built app by-bun')
    expect(built.code).toBe(0)
    expect(existsSync(join(dir, '.acde/web/index.html'))).toBe(true)
    expect(existsSync(join(dir, 'node_modules/@dopame/acde-api/package.json'))).toBe(true)
  }, 60_000)

  for (const pm of ['npm', 'pnpm'] as const) {
    test.skipIf(!PackageManager.which(pm) || !PackageManager.which('node'))(`${pm}: install, run build`, async () => {
      const dir = join(tmp(), `by-${pm}`)
      expect((await cli(['new', dir, '--pm', pm, '--yes'], tmp())).code).toBe(0)
      const path = tools([pm, 'node', 'bun'])
      const installed = await run([pm, 'install'], dir, path)
      expect(installed.code, installed.out).toBe(0)
      const built = await run([pm, 'run', 'build'], dir, path)
      expect(built.out).toContain(`built app by-${pm}`)
      expect(built.code).toBe(0)
      expect(existsSync(join(dir, 'node_modules/@dopame/acde-api/package.json'))).toBe(true)
    }, 180_000)
  }
})

describe('public/ and icons', () => {
  const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d1d1ff0000000049454e44ae426082', 'hex')

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
      'acde.config.jsonc': JSON.stringify({ type: 'desktop', id: 'deck', apps: [{ id: 'cards', label: 'Cards', entry: 'cards.html', icon: 'art/cards.png', backend: false }] }),
      'index.html': '<!doctype html><link rel="stylesheet" href="./desk.css"><p>desk</p>',
      'desk.css': 'body { background: url(/wall.svg); }',
      'cards.html': '<!doctype html><link rel="stylesheet" href="./desk.css"><p>cards</p>',
      'public/wall.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'art/cards.png': PNG_BYTES,
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
    const built = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(built.acde.apps[0].icon).toBe('/app/cards/icon.png')
    expect(readFileSync(join(out, 'apps/cards/web/icon.png')).equals(PNG_BYTES)).toBe(true)
  })

  test('an icon name stays a name; a missing or non-image icon file fails check and build', async () => {
    const named = project({ 'package.json': JSON.stringify({ name: 'named', acde: { icon: 'timer' } }), 'index.html': '<!doctype html><p>x</p>' })
    expect((await cli(['build', '--out', join(named, '.acde')], named)).code).toBe(0)
    expect(JSON.parse(readFileSync(join(named, '.acde/package.json'), 'utf8')).acde.apps[0].icon).toBe('timer')
    const cases: [string, Record<string, string | Buffer>, string][] = [
      ['icons/none.svg', {}, 'no such file'],
      ['icon.txt', { 'icon.txt': 'hi' }, 'an icon image is .svg or .png'],
      ['fake.png', { 'fake.png': '<svg xmlns="http://www.w3.org/2000/svg"/>' }, 'not a PNG image'],
      ['fake.svg', { 'fake.svg': PNG_BYTES }, 'not an SVG image'],
    ]
    for (const [icon, files, problem] of cases) {
      const dir = project({ 'acde.config.jsonc': JSON.stringify({ type: 'app', id: 'iconic', icon }), 'index.html': '<!doctype html><p>x</p>', ...files })
      const message = `icon ${JSON.stringify(icon)} in acde.config.jsonc: ${problem}`
      expect((await cli(['check'], dir)).stderr).toContain(message)
      const built = await cli(['build', '--out', join(dir, '.acde')], dir)
      expect(built.code).toBe(1)
      expect(built.stderr).toContain(message)
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
