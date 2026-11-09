import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const src = fileURLToPath(new URL('../src/', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'acde-api-tiers-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function errors(entry: 'app' | 'shell', code: string): string[] {
  const file = join(dir, `${entry}-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(file, `/// <reference path=${JSON.stringify(join(src, `${entry}.d.ts`))} />\n${code}\n`)
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    types: [],
  })
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

const appCode = `
import { launch } from 'acde:launch'
import { apps } from 'acde:apps'
import self from 'acde:window'
export const started: Promise<number> = launch.start(['foot'])
export const listed = apps.list()
self.setTitle('x')
export const state: 'normal' | 'minimized' | 'filled' | 'fullscreen' = self.state
export const work: number = self.output.workArea.width + self.output.scale
self.requestState('filled')
self.on('state', (event) => event.previous satisfies string)
`

test('an app project sees the app modules, typed', () => {
  assert.deepEqual(errors('app', appCode), [])
})

test('opening a window names a parent and a modal flag, typed', () => {
  const code = `
import { open } from 'acde:open'
import { apps } from 'acde:apps'
import self from 'acde:window'
export const dialog: Promise<{ window: number }> = open('notes', { file: 'a' }, { parent: self.id, modal: true })
export const child = apps.open('notes', null, { parent: 3 })
`
  assert.deepEqual(errors('app', code), [])
  assert.ok(errors('app', `import { open } from 'acde:open'\nopen('notes', null, { parent: 'self' })`).length > 0)
  assert.ok(errors('app', `import { open } from 'acde:open'\nopen('notes', null, { modal: 1 })`).length > 0)
})

test('an app project does not see shell module types', () => {
  const found = errors('app', `import { windows } from 'acde:windows'\nwindows.focus?.(1)`)
  assert.ok(found.length > 0, 'acde:windows must not be typed for apps')
  assert.ok(found.some((m) => /windows/.test(m)), found.join('\n'))
  assert.ok(errors('app', `import { apps } from 'acde:apps'\napps.refresh()`).some((m) => /refresh/.test(m)))
})

test('window states are apart from modes', () => {
  const mode = (value: string) => `import type { WindowMode } from ${JSON.stringify(join(src, 'app.js'))}
export const mode: WindowMode = '${value}'`
  assert.deepEqual(errors('app', mode('free')), [])
  assert.ok(errors('app', mode('fullscreen')).some((m) => /fullscreen/.test(m)))
  assert.ok(errors('app', `import self from 'acde:window'\nself.requestState('maximized')`).length > 0)
  assert.deepEqual(errors('app', `import self from 'acde:window'\nself.requestMode('fullscreen')`), [])
  assert.deepEqual(errors('shell', `import { windows } from 'acde:windows'\nwindows.requestState?.(3, 'minimized')\nwindows.on('state', (e) => e.window)`), [])
})

test('a desktop project sees both tiers', () => {
  const code = `${appCode}
import { windows } from 'acde:windows'
import { packages } from 'acde:packages'
import { session } from 'acde:session'
export const own: boolean = session.own()
export const natives = packages.natives()
windows.list()
`
  assert.deepEqual(errors('shell', code), [])
})

test('a service imports shell modules through its context, typed', () => {
  const code = `
import type { ServiceFactory } from ${JSON.stringify(join(src, 'shell.d.ts'))}
export const factory: ServiceFactory = async (ctx) => {
  const { session } = await ctx.import('acde:session')
  const windows = (await ctx.import('acde:windows')).default
  return { api: { probe: { own: () => session.own(), count: () => windows.list().length } } }
}
`
  assert.deepEqual(errors('shell', code), [])
  const context = `import type { ServiceContext } from ${JSON.stringify(join(src, 'shell.d.ts'))}\ndeclare const ctx: ServiceContext\n`
  assert.ok(errors('shell', `${context}ctx.import('acde:fs')`).length > 0)
})