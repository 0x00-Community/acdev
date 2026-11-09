import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join, relative, sep } from 'node:path'
import { API_LEVEL, platformSupport, RUNNING_MODES } from '@dopame/acde-api/manifest'
import { which } from '../launcher.mjs'
import { Project } from '../src/app.ts'
import { Creator } from '../src/create.ts'
import type { AppPackage } from '../src/package.ts'
import { PackageManager } from '../src/pm.ts'
import { cleanup, collect, env, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const APP = join(import.meta.dir, 'fixtures/app')

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

afterAll(cleanup)

async function answer(out: string, path: string): Promise<string> {
  const sockets = tmp()
  const child = Bun.spawn(
    [process.execPath, '--preload', join(out, 'backend/acde-listen.js'), join(out, 'backend/server.js')],
    {
      env: env({ ACDE_APP_SOCKETS: sockets }),
      stdout: 'ignore',
      stderr: 'inherit',
    },
  )
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
        apiLevel: API_LEVEL,
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
    const css = readdirSync(join(out, 'web'))
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(out, 'web', f), 'utf8'))
      .join('\n')
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
    writeFileSync(
      join(dir, 'server.js'),
      "import http from 'node:http'\nhttp.createServer((req, res) => res.end('hi')).listen(3000)\n",
    )
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
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).devDependencies['@dopame/acde-api']).toStartWith(
      'file:',
    )
    expect((await cli(['check'], dir)).stdout).toContain('app (acde.config.jsonc)')
    expect((await cli(['install'], dir, { XDG_DATA_HOME: data })).code).toBe(0)
    const built = JSON.parse(readFileSync(join(data, 'acde/packages/hello/package.json'), 'utf8'))
    expect(built.acde).toEqual({
      apiLevel: API_LEVEL,
      apps: [{ id: 'hello', label: 'Hi', icon: 'app', entry: '/app/hello/index.html', capabilities: {} }],
      assets: { '/app/hello/': ['web'] },
    })
    expect(existsSync(join(data, 'acde/packages/hello/web/index.html'))).toBe(true)
  })

  test('new --template desktop: builds a desktop, its services and its apps', async () => {
    const dir = join(tmp(), 'mine')
    expect((await cli(['new', dir, '--template', 'desktop', '--label', '我的桌面'], tmp())).code).toBe(0)
    writeFileSync(join(dir, 'clock.js'), 'export default () => ({ methods: { now: () => Date.now() } })\n')
    writeFileSync(join(dir, 'notes.html'), '<!doctype html><title>Notes</title><p>notes</p>\n')
    const config = readFileSync(join(dir, 'acde.config.jsonc'), 'utf8')
    writeFileSync(
      join(dir, 'acde.config.jsonc'),
      config
        .replace('"services": {}', '"services": { "clock": "clock.js" }')
        .replace(
          '"apps": []',
          '"apps": [{ "id": "notes", "label": "Notes", "entry": "notes.html", "backend": false }]',
        ),
    )
    const out = join(tmp(), 'out')
    const result = await cli(['build', '--out', out], dir)
    expect(result.stderr).toBe('')
    const built = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(built.acde.apiLevel).toBe(API_LEVEL)
    expect(built.acde.desktops).toEqual([
      { id: 'mine', name: '我的桌面', entry: 'desktop/index.html', services: ['clock'] },
    ])
    expect(built.acde.services).toEqual([{ name: 'clock', module: 'services/clock.js' }])
    expect(built.acde.apps).toEqual([{ id: 'notes', label: 'Notes', icon: 'app', entry: '/app/notes/notes.html' }])
    expect(built.acde.assets).toEqual({ '/desktop/mine/': ['desktop'], '/app/notes/': ['apps/notes/web'] })
    for (const file of ['desktop/index.html', 'services/clock.js', 'apps/notes/web/notes.html'])
      expect(existsSync(join(out, file))).toBe(true)
    const scripts = readdirSync(join(out, 'desktop'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(out, 'desktop', f), 'utf8'))
    expect(scripts.some((text) => /from\s*"acde:apps"/.test(text))).toBe(true)
  })

  test('a hand-written package (package.json acde.apps) installs as a link', async () => {
    const data = tmp()
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), 'export default { mount() { return () => {} } }\n')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'by-hand',
        acde: { apps: [{ id: 'by-hand', label: 'x', icon: 'apps', entry: '/ui/app.js' }], assets: { '/ui/': ['ui'] } },
      }),
    )
    expect((await cli(['install'], dir, { XDG_DATA_HOME: data })).code).toBe(0)
    expect(readlinkSync(join(data, 'acde/packages/by-hand'))).toBe(realpathSync(dir))
    rmSync(join(dir, 'ui/app.js'))
    const result = await cli(['check'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is in no assets directory')
  })

  test('check: a hand-written package states the contract level of the SDK', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), 'export default { mount() { return () => {} } }\n')
    const write = (level: unknown) =>
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'leveled',
          acde: {
            ...(level !== undefined && { apiLevel: level }),
            apps: [{ id: 'leveled', label: 'x', icon: 'app', entry: '/ui/app.js' }],
            assets: { '/ui/': ['ui'] },
          },
        }),
      )
    write(API_LEVEL)
    const right = await cli(['check'], dir)
    expect(right.code).toBe(0)
    expect(right.stderr).toBe('')
    write(undefined)
    const missing = await cli(['check'], dir)
    expect(missing.code).toBe(0)
    expect(missing.stderr).toContain('warning: acde.apiLevel is missing')
    expect(missing.stderr).toContain(`declare apiLevel ${API_LEVEL}`)
    write(API_LEVEL + 1)
    const wrong = await cli(['check'], dir)
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain(`error: acde.apiLevel ${API_LEVEL + 1}: needs level ${API_LEVEL + 1}`)
    write('1')
    const typed = await cli(['check'], dir)
    expect(typed.code).toBe(1)
    expect(typed.stderr).toContain('error: acde.apiLevel must be a positive whole number')
  })

  test('new . in a fresh git checkout (only .git there)', async () => {
    const dir = tmp()
    mkdirSync(join(dir, '.git'))
    const created = await cli(['new', '.', '--id', 'pomodoro'], dir)
    expect(created.code, created.stderr).toBe(0)
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
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).acde.apps[0].backend).toEqual({
      entry: '/app/with-api/backend/server.js',
      port: 3000,
    })
    expect(JSON.parse(await answer(out, '/api/hello')).hello).toBe('API')
  })

  test('new: the next steps quote a directory with spaces as typed in a shell', () => {
    const dir = join(tmp(), 'my app')
    mkdirSync(dir)
    const rel = relative(process.cwd(), dir)
    const pm = new PackageManager('pnpm')
    const starter = Creator.starter('react')
    const steps = Creator.next({ pkg: { dir } as AppPackage, dir, starter, installed: false, pm })
    expect(steps).toEqual([`cd "${rel}"`, 'pnpm install', 'pnpm acde:dev'])
  })

  test('a framework project gets acde.config.jsonc, the SDK and .acde/ ignored', () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'made-by-vite', devDependencies: { vite: '^7.0.0' } }),
    )
    writeFileSync(join(dir, '.gitignore'), 'node_modules')
    Creator.adopt(dir, 'made-by-vite', 'Vite App', 'React')
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(pkg.devDependencies).toEqual({ vite: '^7.0.0', '@dopame/acde-api': Creator.api(dir) })
    expect(pkg.scripts).toEqual({ 'acde:dev': 'acde dev', 'acde:build': 'acde build', 'acde:check': 'acde check' })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.acde/\n')
    expect(readFileSync(join(dir, 'acde.config.jsonc'), 'utf8')).toContain('"label": "Vite App"')
    Creator.adopt(dir, 'made-by-vite', 'Vite App', 'React')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.acde/\n')
  })

  test('new: no directory and no terminal, or a template that does not exist', async () => {
    expect((await cli(['new'], tmp())).stderr).toContain('new: a directory')
    expect((await cli(['new', 'x', '--template', 'angular'], tmp())).stderr).toContain(
      'template "angular": one of html, react',
    )
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
    const entry = join(ROOT, 'bin/acde.mjs')
    if (WINDOWS) {
      writeFileSync(join(bin, 'acde.cmd'), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
      return bin
    }
    for (const name of names) {
      const found = name === 'bun' ? process.execPath : which(name)
      if (!found) throw new Error(`${name} is not on PATH`)
      symlinkSync(realpathSync(found), join(bin, name))
    }
    writeFileSync(
      join(bin, 'acde'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`,
      { mode: 0o755 },
    )
    return bin
  }

  function basePath(program: string): string[] {
    if (!WINDOWS) return ['/usr/bin', '/bin']
    if (program === process.execPath) return [join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32')]
    return (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  }

  function run(argv: string[], cwd: string, path: string, extra: Record<string, string> = {}) {
    const program = argv[0]!
    const PATH = [path, ...basePath(program)].join(delimiter)
    return collect([which(program) ?? program, ...argv.slice(1)], {
      cwd, env: env({ PATH, npm_config_user_agent: '', ...extra }),
    })
  }

  test('the SDK is a relative file: path, scripts call acde from PATH, there is no acde dependency', () => {
    const dir = ROOT
    expect(Creator.INSTALLED).toBe(false)
    expect(Creator.api(dir)).toBe(`file:${relative(dir, API).split(sep).join('/')}`)
    expect(relative(dir, API)).toStartWith('..')
  })

  test('npm, pnpm and yarn projects get vite for the html and desktop templates, bun ones do not', () => {
    for (const [pm, vite] of [
      ['bun', undefined],
      ['npm', Creator.VITE],
      ['pnpm', Creator.VITE],
      ['yarn', Creator.VITE],
    ] as const) {
      for (const kind of ['app', 'desktop'] as const) {
        const dir = join(tmp(), `${kind}-${pm}`)
        Creator.lay(dir, kind, pm, `${kind}-${pm}`, `${kind}-${pm}`)
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
      process.env['npm_config_user_agent'] = 'other/1.0.0 darwin arm64'
      delete process.env['ACDE_HOST_RUNTIME']
      expect(PackageManager.invoking().name).toBe('bun')
      process.env['ACDE_HOST_RUNTIME'] = 'node'
      expect(PackageManager.invoking().name).toBe('npm')
      expect(() => PackageManager.named('other')).toThrow('one of bun, npm, pnpm, yarn')
      expect(PackageManager.named('pnpm').exec('create-vite@latest', ['x'])).toEqual([
        expect.stringMatching(/(?:^|[/\\])pnpm(?:\.(?:exe|cmd|bat))?$/i),
        'dlx',
        'create-vite@latest',
        'x',
      ])
      expect(PackageManager.named('bun').exec('sv@latest', ['create'])).toEqual([
        process.execPath,
        'x',
        '--bun',
        'sv@latest',
        'create',
      ])
    } finally {
      for (const [key, value] of [
        ['npm_config_user_agent', saved.agent],
        ['ACDE_HOST_RUNTIME', saved.runtime],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('bun: bun install && bun run build with the checkout acde on PATH, no node there', async () => {
    const dir = join(tmp(), 'by-bun')
    expect((await cli(['new', dir, '--pm', 'bun', '--yes'], tmp())).code).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager).toBe(
      `bun@${process.versions.bun}`,
    )
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
    test.skipIf(!which(pm) || !which('node'))(
      `${pm}: install, run build`,
      async () => {
        const dir = join(tmp(), `by-${pm}`)
        expect((await cli(['new', dir, '--pm', pm, '--yes'], tmp())).code).toBe(0)
        expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager).toStartWith(`${pm}@`)
        const path = tools([pm, 'node', 'bun'])
        const installed = await run([pm, 'install'], dir, path)
        expect(installed.code, installed.out).toBe(0)
        const built = await run([pm, 'run', 'build'], dir, path)
        expect(built.out).toContain(`built app by-${pm}`)
        expect(built.code).toBe(0)
        expect(existsSync(join(dir, 'node_modules/@dopame/acde-api/package.json'))).toBe(true)
      },
      180_000,
    )
  }
})

describe('public/ and icons', () => {
  const PNG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000d4944415478da63f8cfc0f01f0005000201a1d1d1ff0000000049454e44ae426082',
    'hex',
  )

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
    expect(result.stderr).toContain(`/fonts/gone.woff2 in style.css: there is no ${join('public/fonts/gone.woff2')}`)
  })

  test('an HTML reference to /x that is nowhere names public/ too', async () => {
    const dir = project({
      'package.json': '{"name": "lost-icon"}',
      'index.html': '<!doctype html><link rel="icon" href="/gone.svg"><p>x</p>',
    })
    const result = await cli(['build', '--out', join(dir, '.acde')], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`/gone.svg in index.html: there is no ${join('public/gone.svg')}`)
  })

  test('a desktop page and its apps: CSS url(/...) into public/ is bundled (no / mount there)', async () => {
    const dir = project({
      'acde.config.jsonc': JSON.stringify({
        type: 'desktop',
        id: 'deck',
        apps: [{ id: 'cards', label: 'Cards', entry: 'cards.html', icon: 'art/cards.png', backend: false }],
      }),
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
    const css = (web: string) =>
      readdirSync(join(out, web))
        .filter((f) => f.endsWith('.css'))
        .map((f) => readFileSync(join(out, web, f), 'utf8'))
        .join('')
    for (const [web, prefix] of [
      ['desktop', '/desktop/deck/'],
      ['apps/cards/web', '/app/cards/'],
    ] as const) {
      expect(css(web)).not.toContain('url(/wall.svg)')
      expect(css(web)).toMatch(new RegExp(`url\\((?:data:image/svg|${prefix}wall-)`))
    }
    const built = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(built.acde.apps[0].icon).toBe('/app/cards/icon.png')
    expect(readFileSync(join(out, 'apps/cards/web/icon.png')).equals(PNG_BYTES)).toBe(true)
  })

  test('an icon name stays a name; a missing or non-image icon file fails check and build', async () => {
    const named = project({
      'acde.config.jsonc': JSON.stringify({ type: 'app', id: 'named', icon: 'timer' }),
      'index.html': '<!doctype html><p>x</p>',
    })
    expect((await cli(['build', '--out', join(named, '.acde')], named)).code).toBe(0)
    expect(JSON.parse(readFileSync(join(named, '.acde/package.json'), 'utf8')).acde.apps[0].icon).toBe('timer')
    const cases: [string, Record<string, string | Buffer>, string][] = [
      ['icons/none.svg', {}, 'no such file'],
      ['icon.txt', { 'icon.txt': 'hi' }, 'an icon image is .svg or .png'],
      ['fake.png', { 'fake.png': '<svg xmlns="http://www.w3.org/2000/svg"/>' }, 'not a PNG image'],
      ['fake.svg', { 'fake.svg': PNG_BYTES }, 'not an SVG image'],
    ]
    for (const [icon, files, problem] of cases) {
      const dir = project({
        'acde.config.jsonc': JSON.stringify({ type: 'app', id: 'iconic', icon }),
        'index.html': '<!doctype html><p>x</p>',
        ...files,
      })
      const message = `icon ${JSON.stringify(icon)} in acde.config.jsonc: ${problem}`
      expect((await cli(['check'], dir)).stderr).toContain(message)
      const built = await cli(['build', '--out', join(dir, '.acde')], dir)
      expect(built.code).toBe(1)
      expect(built.stderr).toContain(message)
    }
  })
})

describe('acde check --platform', () => {
  function project(config: object): string {
    const dir = tmp()
    writeFileSync(join(dir, 'acde.config.jsonc'), JSON.stringify(config))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><p>x</p>')
    return dir
  }

  test('an app requiring terminal fails on Windows in every mode; optional, it passes with a note', async () => {
    const required = project({ type: 'app', id: 'term', capabilities: { terminal: true, fs: true } })
    const failed = await cli(['check', '--platform', 'windows'], required)
    expect(failed.code).toBe(1)
    for (const mode of RUNNING_MODES.filter((m) => platformSupport('win32', m)))
      expect(failed.stderr).toContain(`error: windows (${mode}): app "term" requires terminal, which this mode lacks`)
    expect(failed.stderr).not.toContain('requires fs')
    const linux = await cli(['check', '--platform', 'linux'], required)
    expect(linux.code).toBe(0)
    expect(linux.stdout).toContain('linux (session, desktop, standalone): every required capability is there')

    const optional = project({ type: 'app', id: 'term', capabilities: { terminal: true }, optional: ['terminal'] })
    const noted = await cli(['check', '--platform', 'windows'], optional)
    expect(noted.code).toBe(0)
    expect(noted.stderr).toContain('note: windows (desktop): app "term" runs without optional terminal')
    expect(noted.stderr).not.toContain('error:')
  })

  test('a hand-written package and the apps of a desktop are checked too; an unknown platform is refused', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), 'export default { mount() { return () => {} } }\n')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'cam',
        acde: {
          apiLevel: API_LEVEL,
          apps: [{ id: 'cam', label: 'Cam', icon: 'app', entry: '/ui/app.js', capabilities: { camera: true } }],
          assets: { '/ui/': ['ui'] },
        },
      }),
    )
    const camera = await cli(['check', '--platform', 'windows'], dir)
    expect(camera.code).toBe(1)
    expect(camera.stderr).toContain('error: windows (standalone): app "cam" requires camera, which this mode lacks')
    expect((await cli(['check', '--platform', 'macos'], dir)).code).toBe(0)

    const desk = project({
      type: 'desktop', id: 'desk',
      apps: [{ id: 'net', label: 'Net', entry: 'index.html', backend: false, capabilities: { network: true } }],
    })
    const mac = await cli(['check', '--platform', 'macos'], desk)
    expect(mac.code).toBe(1)
    expect(mac.stderr).toContain('error: macos (desktop): app "net" requires network, which this mode lacks')

    const unknown = await cli(['check', '--platform', 'beos'], desk)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('--platform beos: windows, macos or linux')
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
    expect(Project.idOf('@scope/My_App')).toBe('my-app')
    expect(Project.idOf('notes')).toBe('notes')
    expect(Project.idOf('@x/--')).toBeNull()
  })
})
