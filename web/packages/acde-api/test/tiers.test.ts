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
`

test('an app project sees the app modules, typed', () => {
  assert.deepEqual(errors('app', appCode), [])
})

test('an app project does not see shell module types', () => {
  const found = errors('app', `import { windows } from 'acde:windows'\nwindows.focus?.(1)`)
  assert.ok(found.length > 0, 'acde:windows must not be typed for apps')
  assert.ok(found.some((m) => /windows/.test(m)), found.join('\n'))
  assert.ok(errors('app', `import { apps } from 'acde:apps'\napps.refresh()`).some((m) => /refresh/.test(m)))
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
