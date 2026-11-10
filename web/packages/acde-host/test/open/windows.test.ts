import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppManifest } from '../../src/apps.ts'
import { Opener, OpenWith, type OpenCaller, type SystemHandler } from '../../src/open.ts'
import { bindNatives } from '../../src/sys/natives.ts'

const DESKTOP = 'C:/Users/u/Desktop'
const REGISTRY: Record<string, string> = { '.png': 'image/png', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
const PHOTOS: SystemHandler = { id: 'Microsoft.Windows.Photos_8wekyb3d8bbwe!App', label: 'Photos', icon: 'data:image/png;base64,AA==', default: true }
const PAINT: SystemHandler = { id: 'C:\\Windows\\System32\\mspaint.exe', label: 'Paint', icon: '', default: false }
const CODE: SystemHandler = { id: 'C:\\Program Files\\Code\\Code.exe', label: 'Visual Studio Code', icon: '', default: false }
const HANDLERS: Record<string, SystemHandler[]> = { '.png': [PHOTOS, PAINT], '.md': [CODE] }

const files = new Map<string, string>([[`${DESKTOP}/photo.png`, ''], [`${DESKTOP}/notes.md`, ''], [`${DESKTOP}/data.xyz`, '']])
const statOf = (path: string) => (files.has(path) ? { isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtimeMs: 0, mode: 0o666 } : null)
const asked: string[] = []
bindNatives({
  host: {} as never,
  sys: {
    platform: 'win32',
    argv: [],
    env: () => ({ HOME: 'C:/Users/u' }),
    homedir: () => 'C:/Users/u',
    exists: (path: string) => files.has(path),
    stat: statOf,
    readText: (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
      return text
    },
    writeFile: (path: string, data: string) => void files.set(path, String(data)),
    mkdir: () => {},
    contentType: (ext: string) => (asked.push(ext), REGISTRY[ext] ?? null),
  } as never,
})

const app = (id: string, mimeTypes: string[]) =>
  ({ id, label: id, icon: `${id}.png`, mimeTypes, schemes: [], capabilities: {}, requests: [] }) as unknown as AppManifest
const APPS = [app('notes', ['text/markdown']), app('viewer', ['image/*']), app('files', ['inode/directory'])]

function windowsHost() {
  const opened: [string, string][] = []
  const system: string[] = []
  const host = {
    apps: () => APPS,
    associations: () => ({
      handlers: async (ext: string) => HANDLERS[ext] ?? [],
      open: async (handler: string, path: string) => void opened.push([handler, path]),
    }),
    locate: async () => null,
    admit: async (path: string, caller: OpenCaller | null) => (caller ? null : path),
    launch: async () => ({ window: 7 }),
    spawn: () => assert.fail('Windows hosts launch no .desktop files'),
    system: () => async (target: string) => void system.push(target),
    unsupported: () => null,
    view: () => 'url' as const,
  }
  return { opener: new Opener(host), opened, system }
}

test('Windows: a known type lists the acde apps for it and the registered programs, the system default marked', async () => {
  const { opener } = windowsHost()
  const listed = await opener.handlers(`${DESKTOP}/photo.png`)
  assert.equal(listed.mime, 'image/png')
  assert.equal(listed.association, '.png')
  assert.deepEqual(
    listed.handlers.map((h) => [h.kind, h.id, h.default, h.system ?? null]),
    [['acde', 'viewer', true, null], ['native', PHOTOS.id, false, true], ['native', PAINT.id, false, false]],
  )
  assert.equal(listed.handlers[1]!.icon, PHOTOS.icon)
})

test('Windows: a type the system does not know still offers the registered programs and every app that opens files', async () => {
  const { opener, system } = windowsHost()
  const listed = await opener.handlers(`${DESKTOP}/notes.md`)
  assert.equal(listed.mime, '')
  assert.equal(listed.association, '.md')
  assert.deepEqual(listed.handlers.map((h) => [h.kind, h.id, h.default]), [['acde', 'notes', false], ['acde', 'viewer', false], ['native', CODE.id, false]])
  assert.deepEqual(await opener.open(`${DESKTOP}/data.xyz`), { kind: 'native', id: Opener.SYSTEM })
  assert.deepEqual(system, [`${DESKTOP}/data.xyz`])
})

test('Windows: a remembered program is kept per extension and opens the file; the system default is not touched', async () => {
  const { opener, opened } = windowsHost()
  await assert.rejects(opener.setDefault('.md', 'C:\\nowhere.exe'), { status: 404 })
  await assert.rejects(opener.setDefault('text/markdown', CODE.id), { status: 400 })
  const file = await opener.setDefault('.MD', CODE.id)
  assert.match(file, /acde-extensions\.list$/)
  assert.equal(files.get(file), `[Default Applications]\n.md=${CODE.id};\n`)
  const listed = await opener.handlers(`${DESKTOP}/notes.md`)
  assert.deepEqual(listed.handlers.filter((h) => h.default).map((h) => h.id), [CODE.id])
  assert.deepEqual(await opener.open(`${DESKTOP}/notes.md`), { kind: 'native', id: CODE.id })
  assert.deepEqual(opened, [[CODE.id, `${DESKTOP}/notes.md`]])
  await opener.setDefault('.md', 'notes')
  assert.deepEqual((await opener.handlers(`${DESKTOP}/notes.md`)).handlers.filter((h) => h.default).map((h) => h.id), ['notes'])
})

test('Windows: only the desktop names a program to open a file with', async () => {
  const { opener, opened } = windowsHost()
  const caller = { roots: [DESKTOP], owner: 'viewer' }
  await assert.rejects(opener.open(`${DESKTOP}/photo.png`, { app: PAINT.id }, caller), { status: 403 })
  assert.deepEqual(await opener.open(`${DESKTOP}/photo.png`, { app: PAINT.id }), { kind: 'native', id: PAINT.id })
  assert.deepEqual(opened, [[PAINT.id, `${DESKTOP}/photo.png`]])
})

test('Windows: types come from the registry by extension, asked natively', () => {
  assert.ok(asked.includes('.png') && asked.includes('.md'))
  assert.equal(OpenWith.isExtension('.PNG'), true)
  for (const key of ['png', '.tar.gz', 'text/plain', '.']) assert.equal(OpenWith.isExtension(key), false, key)
  assert.equal(OpenWith.takesFiles(['inode/directory']), false)
  assert.equal(OpenWith.takesFiles(['image/*']), true)
})
