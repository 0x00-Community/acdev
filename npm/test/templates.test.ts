import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_LEVEL, Manifest, SHARED_PLACES, type PackageManifest } from '@dopame/acde-api/manifest'
import { Creator } from '../src/create.ts'
import { AppPackage } from '../src/package.ts'
import { Jsonc } from '../src/runtime.ts'
import { cleanup, collect, env, tmp } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const TEMPLATES = join(import.meta.dir, '../templates')
const LEVEL_1_FIELDS = ['capabilities', 'optional', 'services', 'requests', 'schemes']

function cli(args: string[], cwd: string) {
  return collect([process.execPath, CLI, ...args], { cwd, env: env({}) })
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function config(dir: string): Record<string, unknown> {
  return Jsonc.parse(readFileSync(join(dir, 'acde.config.jsonc'), 'utf8')) as Record<string, unknown>
}

function expectLevel1App(app: Record<string, unknown>, id: string): void {
  for (const field of LEVEL_1_FIELDS) expect(Object.keys(app)).toContain(field)
  const parsed = Manifest.app({ ...app, id, icon: 'app', entry: `/app/${id}/index.html`, backend: undefined })
  expect(typeof parsed === 'string' ? parsed : null).toBeNull()
  const fs = (app['capabilities'] as { fs?: unknown }).fs
  const roots = typeof fs === 'object' && fs ? (fs as { roots: string[] }).roots : []
  for (const root of roots) expect(SHARED_PLACES as readonly string[]).toContain(root)
}

afterAll(cleanup)

describe('templates at contract level 1', () => {
  test('no template keeps a level 0 shape: copyIn, apps.launch or the undivided SDK types', () => {
    for (const file of files(TEMPLATES)) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toContain('copyIn')
      expect(text, file).not.toContain('apps.launch')
      expect(text, file).not.toMatch(/reference types="@dopame\/acde-api"/)
    }
    expect(readFileSync(join(TEMPLATES, 'desktop/src/desktop.js'), 'utf8')).toContain(
      '/// <reference types="@dopame/acde-api/shell" />',
    )
  })

  test('the desktop template says what its config can give a service: the fields of the schema', () => {
    type Form = { type: string; properties?: Record<string, unknown>; required?: string[] }
    const schema = JSON.parse(readFileSync(join(import.meta.dir, '../node_modules/@dopame/acde-api/config.schema.json'), 'utf8')) as
      { oneOf: { properties: { type: { const?: string }; services?: { additionalProperties?: { oneOf?: Form[] } } } }[] }
    const desktop = schema.oneOf.find((one) => one.properties.type.const === 'desktop')!
    const forms = desktop.properties.services!.additionalProperties!.oneOf!
    expect(forms.map((form) => form.type)).toEqual(['string', 'object'])
    expect(Object.keys(forms[1]!.properties!)).toEqual(['module', 'modules'])
    expect(forms[1]!.required).toEqual(['module'])
    const comment = readFileSync(join(TEMPLATES, 'desktop/acde.config.jsonc'), 'utf8')
    expect(comment).toContain('"clock": "services/clock.ts"')
    expect(comment).toContain('"clock": { "module": "services/clock.ts", "modules": ["windows"] }')
    expect(comment).not.toContain('has no field for that grant')
    const example = comment.match(/"clock": (\{ "module"[^}]*\})/)![1]!
    expect(Manifest.configServices({ clock: JSON.parse(example) })).toEqual([
      { name: 'clock', module: 'services/clock.ts', modules: ['windows'] },
    ])
  })

  for (const [name, args] of [
    ['html', ['--template', 'html']],
    ['html --backend', ['--template', 'html', '--backend']],
    ['desktop', ['--template', 'desktop']],
  ] as const) {
    test(`${name}: checks clean, builds at level ${API_LEVEL} and the SDK validator finds nothing`, async () => {
      const dir = join(tmp(), 'starter')
      const made = await cli(['new', dir, ...args, '--label', 'Starter', '--no-install'], tmp())
      expect(made.code, made.stderr).toBe(0)
      const own = config(dir)
      if (own['type'] === 'app') expectLevel1App(own, 'starter')
      const checked = await cli(['check'], dir)
      expect(checked.stderr).toBe('')
      expect(checked.code).toBe(0)
      const out = join(tmp(), 'out')
      const built = await cli(['build', '--out', out], dir)
      expect(built.stderr).toBe('')
      expect(built.code).toBe(0)
      const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).acde as PackageManifest
      expect(manifest.apiLevel).toBe(API_LEVEL)
      expect(AppPackage.check(out, manifest)).toEqual({ errors: [], warnings: [] })
    }, 60_000)
  }

  test('a desktop app written the template way is a level 1 system app', async () => {
    const dir = join(tmp(), 'deck')
    expect((await cli(['new', dir, '--template', 'desktop', '--no-install'], tmp())).code).toBe(0)
    writeFileSync(join(dir, 'notes.html'), '<!doctype html><title>Notes</title><p>notes</p>\n')
    const notes = {
      id: 'notes', label: 'Notes', entry: 'notes.html', backend: false,
      capabilities: { fs: { roots: ['documents'] }, windows: true }, optional: ['fs'], services: [],
      requests: ['add-note'], schemes: ['web+notes'],
    }
    const text = readFileSync(join(dir, 'acde.config.jsonc'), 'utf8')
    writeFileSync(join(dir, 'acde.config.jsonc'), text.replace('"apps": []', `"apps": [${JSON.stringify(notes)}]`))
    expectLevel1App(notes, 'notes')
    const out = join(tmp(), 'out')
    const built = await cli(['build', '--out', out], dir)
    expect(built.stderr).toBe('')
    const app = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).acde.apps[0]
    expect(app).toMatchObject({ optional: ['fs'], requests: ['add-note'], schemes: ['web+notes'] })
  }, 60_000)

  test('a framework project takes --label as its page title wherever its scaffold sets one', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'titled' }))
    const put = (path: string, text: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    put('index.html', '<!doctype html><title>Vite + React</title>')
    put('app/layout.tsx', 'export const metadata: Metadata = {\n  title: "Create Next App",\n}\n')
    put('src/pages/index.astro', '<html><head><title>Astro</title></head></html>')
    put('src/app.html', '<head>\n\t\t%sveltekit.head%\n</head>')
    put('app/app.vue', '<template>\n  <NuxtWelcome />\n</template>\n')
    Creator.adopt(dir, 'titled', 'Mine & <Yours>', 'Test')
    const read = (path: string) => readFileSync(join(dir, path), 'utf8')
    expect(read('index.html')).toContain('<title>Mine &amp; &lt;Yours&gt;</title>')
    expect(read('app/layout.tsx')).toContain('title: "Mine & <Yours>",')
    expect(read('src/pages/index.astro')).toContain('<title>Mine &amp; &lt;Yours&gt;</title>')
    const head = '<head>\n\t\t<title>Mine &amp; &lt;Yours&gt;</title>\n\t\t%sveltekit.head%\n</head>'
    expect(read('src/app.html')).toBe(head)
    expect(read('app/app.vue')).toStartWith('<script setup lang="ts">\nconst label = "Mine & <Yours>"\n')
    Creator.adopt(dir, 'titled', 'Again', 'Test')
    expect(read('app/app.vue').match(/<script/g)).toHaveLength(1)
    expect(read('src/app.html')).toContain('<title>Again</title>')
  })

  const vite = join(import.meta.dir, 'fixtures', 'create-vite')
  for (const template of readdirSync(vite)) {
    test(`create-vite ${template}: no page or README mentions HMR once acde adopts it (acde dev reloads)`, () => {
      const dir = tmp()
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'made-by-vite' }))
      cpSync(join(vite, template), dir, { recursive: true })
      for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.txt')))
        renameSync(join(dir, file), join(dir, file.slice(0, -'.txt'.length)))
      mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '// save to test HMR')
      Creator.adopt(dir, 'made-by-vite', 'Vite App', 'React')
      const read = (path: string) => readFileSync(join(dir, path), 'utf8')
      const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((f) => !f.startsWith('node_modules'))
      for (const file of files.filter((f) => /\.(tsx|vue|svelte|ts|md)$/.test(f)))
        expect(read(file), file).not.toMatch(/hmr/i)
      const pages = files.filter((f) => /\.(tsx|vue|svelte|ts)$/.test(f))
      const reloads = /Edit <code>[^<]+<\/code> and save to reload the page/
      for (const page of pages) expect(read(page), page).toMatch(reloads)
      expect(read(join('node_modules', 'x', 'index.js'))).toBe('// save to test HMR')
    })
  }

  test('the HMR wording: plain, wrapped in <code>, split over lines; README sentences and sections', () => {
    expect(Creator.reloading('Edit <code>src/App.tsx</code> and save to test <code>HMR</code>'))
      .toBe('Edit <code>src/App.tsx</code> and save to reload the page')
    expect(Creator.reloading('Edit <code>src/my-element.ts</code> and save to test\n    <code>HMR</code>'))
      .toBe('Edit <code>src/my-element.ts</code> and save to reload the page')
    expect(Creator.reloading('Edit <code>x.vue</code> to test HMR'))
      .toBe('Edit <code>x.vue</code> and save to reload the page')
    expect(Creator.readmeReloading('React working in Vite with HMR and some Oxlint rules.'))
      .toBe('React working in Vite with some Oxlint rules.')
    expect(Creator.readmeReloading('**Why?**\n\nkept\n\n**Why is HMR odd?**\n\ngone\n\n**Next**\n\nkept too\n'))
      .toBe('**Why?**\n\nkept\n\n**Next**\n\nkept too\n')
  })

  test('the framework overlay declares the same level 1 fields', () => {
    const dir = tmp()
    const pkg = { name: 'made-by-vite', devDependencies: { vite: '^8.0.0' } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    Creator.adopt(dir, 'made-by-vite', 'Vite App', 'React')
    const own = config(dir)
    expect(own['entry']).toBeUndefined()
    expectLevel1App(own, 'made-by-vite')
  })

  test('--backend on a Vite project adds server.ts alone, and acde build bundles it as the backend', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/main.ts'), 'document.title = "vite"\n')
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title><script type="module" src="/src/main.ts"></script>\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'with-api', type: 'module' }))
    Creator.adopt(dir, 'with-api', 'With API', 'Vanilla')
    Creator.serve(dir, 'with-api', 'With API')
    expect(readFileSync(join(dir, 'server.ts'), 'utf8')).toContain("'/api/hello'")
    expect(readdirSync(join(dir, 'src'))).toEqual(['main.ts'])
    expect(() => Creator.serve(dir, 'with-api', 'With API')).toThrow('server.ts is there already')
    const out = join(tmp(), 'out')
    const built = await cli(['build', '--out', out], dir)
    expect(built.code, built.stderr).toBe(0)
    expect(readdirSync(join(out, 'backend')).sort()).toEqual(['acde-listen.js', 'package.json', 'server.js'])
  }, 60_000)

  for (const [template, says] of [
    ['next', 'Next.js has its own server'],
    ['nuxt', 'Nuxt has its own server'],
    ['sveltekit', 'SvelteKit has its own server'],
    ['astro', 'Astro has its own server'],
    ['desktop', 'Desktop has no backend'],
  ] as const) {
    test(`${template} --backend is refused before anything is made`, async () => {
      const dir = join(tmp(), 'refused')
      const made = await cli(['new', dir, '--template', template, '--backend', '--yes', '--no-install'], tmp())
      expect(made.code).not.toBe(0)
      expect(made.stderr).toContain(`--backend: ${says}`)
      expect(existsSync(dir)).toBe(false)
    })
  }
})

describe('templates speak English and carry a small i18n setup', () => {
  const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯]/

  test('pages declare the colour schemes they support: the app follows the system, the desktop is dark', () => {
    const page = (template: string) => readFileSync(join(TEMPLATES, template, 'index.html'), 'utf8')
    expect(page('app')).toContain('<meta name="color-scheme" content="light dark" />')
    expect(page('app')).toContain(':root { color-scheme: light dark }')
    expect(page('app')).toContain('@media (prefers-color-scheme: dark)')
    expect(page('desktop')).toContain('<meta name="color-scheme" content="dark" />')
  })

  test('no CJK text outside the zh message tables, and no hard-coded lang', () => {
    for (const file of files(TEMPLATES)) {
      const text = readFileSync(file, 'utf8')
      if (!/[\\/]locales[\\/]zh\.js$/.test(file)) expect(CJK.test(text), file).toBe(false)
      expect(text, file).not.toContain('lang="zh"')
    }
  })

  for (const template of ['app', 'desktop']) {
    test(`${template}: every language has the keys of en, and i18n.js is the same in every template`, async () => {
      const dir = join(TEMPLATES, template, 'src')
      const tables = readdirSync(join(dir, 'locales')).map((file) => file.replace(/\.js$/, ''))
      expect(tables).toEqual(expect.arrayContaining(['en', 'zh']))
      const keys = async (lang: string) =>
        Object.keys(((await import(join(dir, 'locales', `${lang}.js`))) as { default: object }).default).sort()
      const english = await keys('en')
      for (const lang of tables) expect(await keys(lang), lang).toEqual(english)
      const i18n = readFileSync(join(dir, 'i18n.js'), 'utf8')
      expect(i18n).toBe(readFileSync(join(TEMPLATES, 'app', 'src', 'i18n.js'), 'utf8'))
      for (const lang of tables) expect(i18n).toContain(`import ${lang} from './locales/${lang}.js'`)
    })
  }

  test('navigator.language picks the table: exact tag, base language, else en; a missing key stays', async () => {
    const run = (language: string, key: string) => collect([process.execPath, '-e', `
      globalThis.navigator = { language: ${JSON.stringify(language)} }
      const { locale, t } = await import(${JSON.stringify(join(TEMPLATES, 'app', 'src', 'i18n.js'))})
      console.log(locale + '|' + t(${JSON.stringify(key)}, { language: 'L', time: 'T' }))
    `], { cwd: TEMPLATES, env: env({}) })
    const results = await Promise.all([
      run('zh-CN', 'status'), run('en-GB', 'status'), run('fr', 'status'), run('zh', 'nope'),
    ])
    expect(results.map((r) => r.stdout.trim())).toEqual([
      'zh|语言 L · T', 'en|Language L · T', 'en|Language L · T', 'zh|nope',
    ])
  })
})
