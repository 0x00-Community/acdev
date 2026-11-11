import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const src = fileURLToPath(new URL('../src/', import.meta.url)).replaceAll('\\', '/')
const dir = mkdtempSync(join(tmpdir(), 'acde-api-types-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  types: [],
}

function compile(entry: 'app' | 'shell', code: string): { program: ts.Program; file: string } {
  const file = join(dir, `${entry}-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(file, `/// <reference path=${JSON.stringify(join(src, `${entry}.d.ts`))} />\n${code}\n`)
  return { program: ts.createProgram([file], options), file }
}

function errors(entry: 'app' | 'shell', code: string): string[] {
  const { program } = compile(entry, code)
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

function untyped(): string[] {
  const { program, file } = compile(
    'shell',
    `import type { AcdeApps, AppRequest, ShellModules, SystemRequest, WindowRequest } from ${JSON.stringify(`${src}shell`)}
export type Probe = {
  modules: ShellModules
  apps: AcdeApps
  requests: [WindowRequest, SystemRequest, AppRequest, AppRequest<'task', { title: string; due: number | null }>]
}`,
  )
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(file)!
  const probe = source.statements.find(ts.isTypeAliasDeclaration)!
  const found: string[] = []
  const seen = new Set<ts.Type>()
  const deprecated = (node: ts.Node | undefined) => !!node && ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'deprecated')
  const library = (type: ts.Type) => {
    const declarations = (type.aliasSymbol ?? type.getSymbol())?.declarations ?? []
    return declarations.length > 0 && declarations.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
  }
  const loose = (type: ts.Type) => (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0
  const visit = (type: ts.Type, at: string): void => {
    if (loose(type)) return void found.push(at)
    if (seen.has(type)) return
    seen.add(type)
    if (type.isUnionOrIntersection()) return type.types.forEach((part) => visit(part, at))
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type)
      return constraint ? visit(constraint, at) : undefined
    }
    if (!(type.flags & ts.TypeFlags.Object)) return
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      return checker.getTypeArguments(type as ts.TypeReference).forEach((item) => visit(item, `${at}[]`))
    }
    for (const info of checker.getIndexInfosOfType(type)) visit(info.type, `${at}[key]`)
    if (type.getSymbol()?.name === 'Promise' && library(type)) return checker.getTypeArguments(type as ts.TypeReference).forEach((t) => visit(t, at))
    if (library(type)) return
    for (const property of checker.getPropertiesOfType(type)) {
      if (deprecated(property.valueDeclaration ?? property.declarations?.[0])) continue
      visit(checker.getTypeOfSymbolAtLocation(property, probe), `${at}.${property.name}`)
    }
    for (const signature of type.getCallSignatures()) {
      if (deprecated(signature.getDeclaration())) continue
      visit(signature.getReturnType(), `${at}()`)
      for (const parameter of signature.getParameters()) {
        const handler = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(parameter, probe))
        for (const callback of handler.getCallSignatures()) {
          for (const argument of callback.getParameters()) {
            visit(checker.getTypeOfSymbolAtLocation(argument, probe), `${at}(${parameter.name}: ${argument.name})`)
          }
        }
      }
    }
  }
  visit(checker.getTypeAtLocation(probe.name), 'Probe')
  return [...new Set(found)]
}

test('public events, requests and results carry no unknown or untyped records', () => {
  assert.deepEqual(untyped(), [])
})

test('acde:windows and acde:launch events are a union discriminated by type', () => {
  const code = `
import { windows } from 'acde:windows'
import { launch } from 'acde:launch'
import type { WindowsEvent, WindowState } from '@dopame/acde-api/shell'
windows.on('open', (e) => {
  const kind: 'windowopen' = e.type
  const app: string | null | undefined = e.appId
  const web: true | undefined = e.web
})
windows.on('state', (e) => {
  const now: WindowState = e.state
  const before: WindowState = e.previous
})
windows.on('menus', (e) => e.menus[0]?.items.map((item) => ('type' in item ? item.type : item.action)))
windows.on('crash', (e) => e.reason satisfies string)
windows.on('minsize', (e) => e.width + e.height)
windows.on('parent', (e) => e.parent satisfies number | undefined)
windows.on('animated', (e) => e.window satisfies number)
launch.on('close', (e) => e.type satisfies 'windowclose')
export function describe(e: WindowsEvent): string {
  switch (e.type) {
    case 'windowtitle':
      return e.title ?? ''
    case 'windowcrash':
      return e.reason
    default:
      return String(e.window)
  }
}
`
  assert.deepEqual(errors('shell', code.replaceAll('@dopame/acde-api/shell', `${src}shell`)), [])
  assert.ok(errors('shell', `import { windows } from 'acde:windows'\nwindows.on('close', (e) => e.reason)`).length > 0)
  assert.ok(errors('shell', `import { windows } from 'acde:windows'\nwindows.on('opened', () => {})`).length > 0)
})

test('app list, desktop and terminal events are typed', () => {
  const code = `
import { apps } from 'acde:apps'
import { packages } from 'acde:packages'
import { desktop } from 'acde:desktop'
import { terminal } from 'acde:terminal'
apps.on?.('changed', (e) => e.apps.map((app) => app.label) satisfies string[])
packages.on('changed', (e) => e.type satisfies 'appschanged')
desktop.on('download', (e) => [e.type satisfies 'download', e.path, e.size])
desktop.on('notification', (e) => [e.type satisfies 'notification', e.title, e.tag])
desktop.on('screenshot', (e) => [e.type satisfies 'screenshot', e.path, 'error' in e ? e.error : e.width + e.height])
desktop.on('shortcut', (e) => [e.key, e.window, e.title satisfies 'session' | 'desktop' | 'app'])
void terminal.subscribe('t', (events) => events.map((e) => (e.type === 'output' ? e.data : e.type === 'cwd' ? e.path : e.code)))
`
  assert.deepEqual(errors('shell', code), [])
})

test('an app window types its own events and requests', () => {
  const code = `
import self from 'acde:window'
import type { AppRequest } from ${JSON.stringify(`${src}app`)}
type Task = AppRequest<'task', { title: string; due: number | null }>
type Page = AppRequest<'page', { id: string }>
self.on<Task | Page>('request', (request) => {
  switch (request.kind) {
    case 'task':
      return void (request.title satisfies string, request.due satisfies number | null)
    case 'page':
      return void (request.id satisfies string)
    case 'open-link':
      return void (request.url satisfies string)
    case 'open-file':
      return void [request.url, request.handle?.kind satisfies 'file' | 'directory' | undefined]
  }
})
self.on('request', (request) => request.kind satisfies string)
self.on('grab', (e) => [e.kind satisfies 'pointer' | 'keyboard', e.granted satisfies boolean])
self.on('grablost', (e) => [e.kind satisfies 'lost', e.reason satisfies 'esc' | 'other_window' | 'focus_lost' | 'denied'])
self.on('resume', () => {})
self.on('suspend', () => {})
self.on('shortcut', (e) => e.key satisfies string)
export const closed: Promise<boolean> = self.close()
export const minimized: Promise<void> = self.minimize()
export const asked: Promise<void> = self.requestAttention()
`
  assert.deepEqual(errors('app', code), [])
  const wrong = `import self from 'acde:window'
import type { AppRequest } from ${JSON.stringify(`${src}app`)}
self.on<AppRequest<'task', { title: string }>>('request', (r) => (r.kind === 'task' ? r.due : null))`
  assert.ok(errors('app', wrong).length > 0, 'an undeclared field is an error')
})

test('callers send only typed app requests', () => {
  const code = `
import { open } from 'acde:open'
import type { AppRequest } from ${JSON.stringify(`${src}app`)}
export const typed: Promise<{ window: number }> = open('board', { kind: 'task', title: 'x' })
export const declared: Promise<{ window: number }> = open<AppRequest<'task', { title: string }>>('board', { kind: 'task', title: 'x' })
export const plain: Promise<{ window: number }> = open('notes')
`
  assert.deepEqual(errors('app', code), [])
  const wrong = `import { open } from 'acde:open'
import type { AppRequest } from ${JSON.stringify(`${src}app`)}
open<AppRequest<'task', { title: string }>>('board', { kind: 'task', title: 1 })`
  assert.ok(errors('app', wrong).length > 0)
  assert.ok(errors('app', `import { open } from 'acde:open'\nopen('notes', { file: 'a' })`).length > 0, 'a request without a kind is level 0')
})

test('the SDK has no level 0 window shapes', () => {
  const window = `import self from 'acde:window'
self.on('request', (r: Record<string, unknown>) => r)
self.on('opened', () => {})
self.requestMode('fullscreen')`
  assert.equal(errors('app', window).length, 3, 'untyped request handler, unknown event, full screen as a mode')
  const legacy = ['fullscreen', 'unfullscreen', 'minimize'].map((type) => `windows.on('${type}', () => {})`)
  assert.equal(errors('shell', `import { windows } from 'acde:windows'\n${legacy.join('\n')}`).length, 3, 'the old window events')
})

test('office results follow the runtime', () => {
  const code = `
import { office } from 'acde:office'
const server = await office.server()
if (server.ok) server.version satisfies string | null
else server.problem satisfies 'unreachable' | 'unhealthy' | 'secret' | 'rejected' | 'bridge'
const state = await office.state()
state.entries.map((entry) => entry.kind satisfies 'directory' | 'document')
state.file?.documentType satisfies 'word' | 'cell' | 'slide' | 'pdf' | undefined
state.status?.state satisfies 'open' | 'saving' | 'saved' | 'failed' | 'conflict' | 'closed' | undefined
const editor = state.editor
if (editor) await office.editorPage(editor, 'dark')
const saved = await office.save({ key: 'k' })
saved.status.savedAt satisfies number | null
const created = await office.new({ root: 'r', kind: 'docx' })
created.path satisfies string
`
  assert.deepEqual(errors('app', code), [])
})

test('the typed docs say animations and backdrops are best effort', () => {
  const pages = readFileSync(join(src, 'types', 'page.d.ts'), 'utf8')
  const doc = (member: string) => /\/\*\*([\s\S]*?)\*\/\s*$/.exec(pages.slice(0, pages.search(new RegExp(`\\n\\s*${member}\\??\\(`))))?.[1] ?? ''
  assert.match(doc('animate'), /complete at once/)
  assert.match(doc('animate'), /windowanimated/)
  assert.match(doc('setBackdrop'), /approximat/)
})

test('the desktop answers approval prompts and lists and revokes decisions through acde:permissions', () => {
  const code = `
import { permissions } from 'acde:permissions'
import type { AcdePermissionError, ApprovalCapability } from ${JSON.stringify(`${src}shell`)}
permissions.on('prompt', (prompt) => {
  const capability: ApprovalCapability = prompt.capability
  void permissions.answer(prompt.id, prompt.reason === 'launch' && capability !== 'microphone')
})
permissions.on('answered', (event) => event.allowed satisfies boolean)
const pending = await permissions.pending()
pending.map((prompt) => prompt.app satisfies string)
const decisions = await permissions.list('notes')
decisions.map((d) => d.decision satisfies 'granted' | 'denied')
export const revoked: Promise<boolean> = permissions.revoke('notes', 'camera')
export function refused(error: AcdePermissionError): [403, 'denied' | 'not_asked' | 'asking', string] {
  return [error.status, error.code, error.capability]
}
`
  assert.deepEqual(errors('shell', code), [])
  assert.ok(errors('app', `import { permissions } from 'acde:permissions'\nvoid permissions.pending()`).length > 0, 'apps do not see it')
  assert.ok(errors('shell', `import { permissions } from 'acde:permissions'\nvoid permissions.revoke('notes', 'office')`).length > 0)
})

test('an app tells a capability that was not asked for from one being asked, denied or available', () => {
  const code = `
import { capabilities } from 'acde:capabilities'
import type { AcdePermissionError, CapabilityState } from ${JSON.stringify(`${src}app`)}
export function next(state: CapabilityState): 'use' | 'request' | 'wait' | 'explain' | 'leave out' {
  switch (state) {
    case 'available':
      return 'use'
    case 'not-asked':
      return 'request'
    case 'asking':
      return 'wait'
    case 'denied':
      return 'explain'
    case 'not-declared':
    case 'unsupported':
    case 'service-not-running':
    case 'shell-only':
      return 'leave out'
  }
}
export const now = next(capabilities.get('terminal').state)
export const answered: Promise<CapabilityState> = capabilities.request('terminal').then((status) => status.state)
export function ask(error: AcdePermissionError): boolean {
  return error.code === 'not_asked'
}
`
  assert.deepEqual(errors('app', code), [])
  const unknown = `import { capabilities } from 'acde:capabilities'\nexport const waiting = capabilities.get('terminal').state === 'waiting'`
  assert.ok(errors('app', unknown).length > 0, 'a state the runtime does not report is a type error')
})

test('every row of a window list carries its state', () => {
  const shell = `
import { windows } from 'acde:windows'
import type { WindowState } from ${JSON.stringify(`${src}shell`)}
export const states: WindowState[] = windows.list().map((row) => row.state)
`
  assert.deepEqual(errors('shell', shell), [])
  const app = `
import { launch } from 'acde:launch'
export const minimized: number[] = launch.list().filter((row) => row.state === 'minimized').map((row) => row.id)
export const states: ('normal' | 'minimized' | 'filled' | 'fullscreen')[] = launch.list().map((row) => row.state)
`
  assert.deepEqual(errors('app', app), [])
})
