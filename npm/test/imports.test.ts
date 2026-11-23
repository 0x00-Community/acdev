import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_LEVEL } from '../src/manifest/index.ts'
import { Imports } from '../src/imports.ts'
import { cleanup, collect, env, tmp, WINDOWS } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const MODULES = join(import.meta.dir, '../node_modules')

afterAll(cleanup)

function project(files: Record<string, string>): string {
  const dir = tmp()
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  symlinkSync(MODULES, join(dir, 'node_modules'), WINDOWS ? 'junction' : 'dir')
  return dir
}

function app(capabilities: object, main: string, extra: object = {}, files: Record<string, string> = {}): string {
  return project({
    'acde.config.jsonc': JSON.stringify({ type: 'app', id: 'notes', label: 'Notes', capabilities, ...extra }),
    'index.html': '<!doctype html><title>x</title><script type="module" src="/src/main.ts"></script>',
    'src/main.ts': main,
    ...files,
  })
}

function cli(args: string[], cwd: string, extra: Record<string, string> = {}) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env(extra) })
}

const BUNDLERS = ['bun', 'vite'] as const

async function each(dir: string) {
  const check = await cli(['check'], dir)
  const builds = await Promise.all(
    BUNDLERS.map((bundler) => cli(['build', '--out', join(tmp(), 'out')], dir, { ACDEV_BUNDLER: bundler })),
  )
  return { check, builds }
}

async function passes(dir: string) {
  const { check, builds } = await each(dir)
  expect(check.stderr).toBe('')
  expect(check.code).toBe(0)
  for (const [i, build] of builds.entries()) {
    expect(build.stderr, BUNDLERS[i]).toBe('')
    expect(build.code, BUNDLERS[i]).toBe(0)
  }
}

async function fails(dir: string, message: string) {
  const { check, builds } = await each(dir)
  expect(check.code).toBe(1)
  expect(check.stderr).toContain(`error: ${message}`)
  for (const [i, build] of builds.entries()) {
    expect(build.code, BUNDLERS[i]).toBe(1)
    expect(build.stderr, BUNDLERS[i]).toContain(message)
  }
}

describe('Imports.scan', () => {
  test('static and dynamic imports of acde: with their lines; types, comments and strings are not imports', () => {
    const text = [
      "import { fs } from 'acde:fs'",
      'import type { AcdeFs } from "acde:fs"',
      '// import "acde:terminal"',
      '/* import "acde:office" */',
      'export { apps } from "acde:apps"',
      'import {',
      '  windows,',
      "} from 'acde:windows'",
      "const t = await import('acde:terminal')",
      "const s = 'import x from \"acde:network\"'",
      'const u = obj.import("acde:launch")',
      "import 'acde:session'",
      'const w = await import(`acde:window`)',
      'const d = `acde:${name}`',
      "const r = /'/.test(a); import('acde:open')",
    ].join('\n')
    expect(Imports.scan(text)).toEqual([
      { name: 'fs', line: 1, dynamic: false },
      { name: 'apps', line: 5, dynamic: false },
      { name: 'windows', line: 6, dynamic: false },
      { name: 'terminal', line: 9, dynamic: true },
      { name: 'session', line: 12, dynamic: false },
      { name: 'window', line: 13, dynamic: true },
      { name: 'open', line: 15, dynamic: true },
    ])
  })

  test('HTML and single-file components: only the scripts count, lines kept', () => {
    const html = [
      '<!doctype html>',
      "<p>don't import 'acde:fs' here</p>",
      '<script type="module">',
      "  import { apps } from 'acde:apps'",
      '</script>',
    ].join('\n')
    expect(Imports.scan(html, 'index.html')).toEqual([{ name: 'apps', line: 4, dynamic: false }])
    const astro = ['---', "import { fs } from 'acde:fs'", '---', "<p>it's 'acde:terminal'</p>"].join('\n')
    expect(Imports.scan(astro, 'page.astro')).toEqual([{ name: 'fs', line: 2, dynamic: false }])
  })
})

describe('a third-party app, with Bun and with Vite', () => {
  test('a static import of a required capability passes', async () => {
    await passes(app({ fs: true }, "import { fs } from 'acde:fs'\nconsole.log(fs)\n"))
  })

  test('a static import of an optional capability fails and says to import it dynamically', async () => {
    const dir = app({ fs: true, terminal: true }, "import 'acde:fs'\nimport { terminal } from 'acde:terminal'\n", {
      optional: ['terminal'],
    })
    await fails(dir, `src/main.ts:2: app "notes": acde:terminal is optional ("terminal" is in optional): ` +
      `import it dynamically, await import('acde:terminal'), which rejects where this platform lacks it`)
  })

  test('a dynamic import of an optional capability passes', async () => {
    const main = "const terminal = await import('acde:terminal').catch(() => null)\nconsole.log(terminal)\n"
    await passes(app({ terminal: true }, main, { optional: ['terminal'] }))
  })

  test('an undeclared module fails, also when reached through other modules or imported dynamically', async () => {
    const dir = app({}, "import { list } from './lib'\nlist()\n", {}, {
      'src/lib/index.ts': "export const list = () => import('acde:fs')\n",
      'src/unused.ts': "import 'acde:terminal'\n",
    })
    await fails(dir, 'src/lib/index.ts:1: app "notes": acde:fs needs "fs" in the capabilities of Notes')
    expect((await cli(['check'], dir)).stderr).not.toContain('terminal')
  })

  test('a service is imported by the name the app lists; an app that lists none is told to list the service', async () => {
    const main = "import clock from 'acde:clock'\nconsole.log(clock)\n"
    await fails(app({}, main), 'src/main.ts:1: app "notes": acde:clock is not a system module; if a desktop service ' +
      "provides it, list that service's name in the services of Notes")
    await passes(app({}, main, { services: ['clock'] }))
  })

  test('another namespace of a listed service passes with a note, in check and in both builds', async () => {
    const main = "import clock from 'acde:clock'\nimport timer from 'acde:timer'\nconsole.log(clock, timer)\n"
    const note = 'note: src/main.ts:2: app "notes": acde:timer resolves only if the service Notes lists ("clock") ' +
      'provides the "timer" namespace\n'
    const { check, builds } = await each(app({}, main, { services: ['clock'] }))
    expect(check.stderr).toBe(note)
    expect(check.stdout).toContain('ok: ')
    expect(check.code).toBe(0)
    for (const [i, build] of builds.entries()) {
      expect(build.stderr, BUNDLERS[i]).toBe(note)
      expect(build.code, BUNDLERS[i]).toBe(0)
    }
    const several = await cli(['check'], app({}, main, { services: ['clock', 'store'] }))
    expect(several.stderr).toBe(note.replace('the service Notes lists ("clock")',
      'one of the services Notes lists ("clock", "store")'))
    expect(several.code).toBe(0)
  })

  test('a shell module fails', async () => {
    await fails(
      app({}, "import { windows } from 'acde:windows'\n"),
      'src/main.ts:1: app "notes": acde:windows is a shell module: only the desktop, its services and system apps ' +
        'may import it, and Notes is not a system app',
    )
  })
})

describe('a desktop: its page and system apps', () => {
  function desktop(apps: object[], files: Record<string, string>): string {
    return project({
      'acde.config.jsonc': JSON.stringify({ type: 'desktop', id: 'desk', services: { clock: 'clock.ts' }, apps }),
      'index.html': '<!doctype html><title>d</title><script type="module" src="./desk.ts"></script>',
      'desk.ts': "import { windows } from 'acde:windows'\nimport { session } from 'acde:session'\n" +
        'console.log(windows, session)\n',
      'clock.ts': 'export default () => ({ methods: { now: () => Date.now() } })\n',
      ...files,
    })
  }

  test('the page imports shell modules; a system app imports the ones it declares', async () => {
    await passes(desktop(
      [{ id: 'tools', label: 'Tools', entry: 'tools.html', backend: false, capabilities: { windows: true } }],
      {
        'tools.html': '<!doctype html><script type="module" src="./tools.ts"></script>',
        'tools.ts': "import { windows } from 'acde:windows'\nconsole.log(windows)\n",
      },
    ))
  })

  test('a system app importing a shell module it does not declare fails', async () => {
    const dir = desktop(
      [{ id: 'tools', label: 'Tools', entry: 'tools.ts', backend: false }],
      { 'tools.ts': "import { windows } from 'acde:windows'\nexport default windows\n" },
    )
    await fails(dir, 'tools.ts:1: app "tools": acde:windows is a shell module: declare "windows" in the ' +
      'capabilities of Tools')
  })
})

describe('other projects', () => {
  test('a hand-written package: its entries through the assets', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), "import { load } from './lib.js'\nexport default { mount() { load() } }\n")
    writeFileSync(join(dir, 'ui/lib.js'), "export const load = () => import('acde:office')\n")
    const write = (capabilities: object) => writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'by-hand',
      acde: {
        apiLevel: API_LEVEL,
        apps: [{ id: 'by-hand', label: 'Hand', icon: 'application-x-executable', entry: '/ui/app.js', capabilities }],
        assets: { '/ui/': ['ui'] },
      },
    }))
    write({})
    const result = await cli(['check'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: ui/lib.js:1: app "by-hand": acde:office needs "office" in the capabilities')
    write({ office: true })
    expect((await cli(['check', '--platform', 'linux'], dir)).code).toBe(0)
  })

  test('a hand-written package: the note about a namespace of a listed service, in check and in build', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui/app.js'), "import timer from 'acde:timer'\nexport default { mount() { timer.start() } }\n")
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'by-hand',
      acde: {
        apiLevel: API_LEVEL,
        apps: [{ id: 'by-hand', label: 'Hand', icon: 'application-x-executable', entry: '/ui/app.js', services: ['clock'] }],
        assets: { '/ui/': ['ui'] },
      },
    }))
    const note = 'note: ui/app.js:1: app "by-hand": acde:timer resolves only if the service Hand lists ("clock") ' +
      'provides the "timer" namespace\n'
    for (const command of ['check', 'build']) {
      const result = await cli([command], dir)
      expect(result.stderr, command).toBe(note)
      expect(result.code, command).toBe(0)
    }
  })

  test('a framework app: every source file outside the skipped directories', async () => {
    const dir = project({
      'acde.config.jsonc': JSON.stringify({ type: 'app', id: 'next-app', label: 'Next', capabilities: {} }),
      'package.json': JSON.stringify({ name: 'next-app', dependencies: { next: '16' } }),
      'app/page.tsx': "'use client'\nimport { fs } from 'acde:fs'\nexport default () => <p>it's {String(fs)}</p>\n",
      '.next/server/page.js': "import 'acde:terminal'\n",
    })
    const result = await cli(['check'], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: app/page.tsx:2: app "next-app": acde:fs needs "fs"')
    expect(result.stderr).not.toContain('terminal')
  })
})
