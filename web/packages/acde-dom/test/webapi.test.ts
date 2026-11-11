import assert from 'node:assert/strict'
import { test } from 'node:test'
import { page } from './harness.ts'

const PAGE = '<!doctype html><html><body><a id="frag" href="#part">to part</a><div style="height:3000px"></div><h2 id="part">Part</h2></body></html>'

test('links: a fragment moves location.hash (hashchange); other URLs and new windows go to the host', async () => {
  using web = await page(PAGE)
  const navigated: [string, string][] = []
  web.internals.env.navigate = (url, target) => void navigated.push([url, target])
  web.run(`globalThis.out = []; addEventListener('hashchange', (e) => out.push(new URL(e.newURL).hash))
    document.getElementById('frag').click()`)
  assert.equal(web.run('location.hash'), '#part')
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['#part'])
  web.run(`const a = document.createElement('a'); a.href = '/other/page.html'; document.body.append(a); a.click()
    const b = document.createElement('a'); b.href = 'https://example.com/x'; b.target = '_blank'; document.body.append(b); b.click()
    const c = document.createElement('a'); c.href = '#part'; c.onclick = (e) => e.preventDefault(); document.body.append(c); c.click()`)
  assert.deepEqual(navigated, [
    ['http://acde.local/other/page.html', '_self'],
    ['https://example.com/x', '_blank'],
  ])
})

test('links: <a download>, blob: and data: URLs are saved through the host (the blob taken at the click)', async () => {
  using web = await page()
  const saved: { url: string; name: string; text?: string }[] = []
  const pending: Promise<void>[] = []
  web.internals.env.download = (request) => {
    const entry: { url: string; name: string; text?: string } = { url: request.url.replace(/[0-9a-f-]{36}$/, 'ID'), name: request.name }
    saved.push(entry)
    if (request.blob) pending.push(request.blob.text().then((text) => void (entry.text = text)))
  }
  web.run(`const url = URL.createObjectURL(new Blob(['a,b\\n1,2'], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'table.csv'; a.click(); URL.revokeObjectURL(url)
    const d = document.createElement('a'); d.href = 'data:text/plain,hi'; d.click()
    const f = document.createElement('a'); f.href = '/app/x/report.pdf'; f.setAttribute('download', ''); f.click()
    window.open(URL.createObjectURL(new Blob(['x'])))`)
  await Promise.all(pending)
  assert.deepEqual(saved, [
    { url: 'blob:http://acde.local/ID', name: 'table.csv', text: 'a,b\n1,2' },
    { url: 'data:text/plain,hi', name: '' },
    { url: 'http://acde.local/app/x/report.pdf', name: '' },
    { url: 'blob:http://acde.local/ID', name: '', text: 'x' },
  ])
})

type Node = Uint8Array | 'dir' | 'link'

const SYSTEM_TYPES: Record<string, string> = { '.png': 'image/png', '.txt': 'text/plain', '.md': 'text/markdown' }
const systemType = (name: string) => SYSTEM_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? ''

function chooser(answer: { open?: string[] | null; save?: string | null; directory?: string | null; private?: string }, files: Map<string, Node>) {
  const asked: unknown[] = []
  const name = (path: string) => path.split('/').pop()!
  const kind = (node: Node | undefined) =>
    node === undefined ? null : node === 'dir' ? ('directory' as const) : node === 'link' ? ('other' as const) : ('file' as const)
  const under = (dir: string) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`))
  return {
    asked,
    files: {
      open: async (options: unknown) => (asked.push(options), answer.open ? answer.open.map((path) => ({ name: name(path), path })) : null),
      save: async (options: unknown) => (asked.push(options), answer.save ? { name: name(answer.save), path: answer.save } : null),
      read: async (file: { path: string }) => {
        const node = files.get(file.path)
        return ArrayBuffer.isView(node) ? { bytes: node as Uint8Array, lastModified: 1000 } : null
      },
      write: async (file: { path: string }, bytes: Uint8Array) => void files.set(file.path, bytes.slice()),
      directory: async (options: unknown) => (asked.push(options), answer.directory ? { name: name(answer.directory), path: answer.directory } : null),
      privateDirectory: () => (answer.private ? { name: '', path: answer.private } : null),
      entries: async (dir: { path: string }) =>
        under(dir.path)
          .filter((path) => !path.slice(dir.path.length + 1).includes('/'))
          .map((path) => ({ name: name(path), path, kind: kind(files.get(path))! })),
      entry: async (dir: { path: string }, child: string, create: 'file' | 'directory' | null) => {
        const path = `${dir.path}/${child}`
        if (!files.has(path) && create) files.set(path, create === 'directory' ? 'dir' : new Uint8Array(0))
        const found = kind(files.get(path))
        return found ? { name: child, path, kind: found } : null
      },
      remove: async (dir: { path: string }, child: string, recursive: boolean) => {
        const path = `${dir.path}/${child}`
        if (!files.has(path)) return false
        if (under(path).length && !recursive) throw Object.assign(new Error('directory is not empty'), { code: 'ENOTEMPTY' })
        for (const inner of under(path)) files.delete(inner)
        files.delete(path)
        return true
      },
    },
  }
}

test('<input type=file>: activation opens the chooser; the picked files are its files (input, change, FormData)', async () => {
  using web = await page('<!doctype html><html><body><form><input id="f" type="file" name="doc" accept=".png,image/jpeg" multiple></form></body></html>')
  const files = new Map([['/home/u/a.png', new TextEncoder().encode('PNG')], ['/home/u/b.txt', new TextEncoder().encode('hello')]])
  const c = chooser({ open: ['/home/u/a.png', '/home/u/b.txt'] }, files)
  web.internals.env.files = c.files
  web.internals.env.fileType = systemType
  web.run(`globalThis.out = []; const f = document.getElementById('f')
    f.addEventListener('input', () => out.push('input'))
    f.addEventListener('change', async () => {
      out.push('change', f.files.length, f.files[0].name, f.files[0].type, f.files[1].type, f.value, await f.files[1].text())
      out.push(new FormData(f.form).getAll('doc').map((x) => x.name).join())
    })
    f.click()`)
  await web.wait(5)
  const filters = [{ name: '.png, image/jpeg', globs: ['*.png'], mimes: ['image/jpeg'] }]
  assert.deepEqual(JSON.parse(JSON.stringify(c.asked)), [{ multiple: true, directory: false, filters }])
  assert.deepEqual(web.json('out'), ['input', 'change', 2, 'a.png', 'image/png', 'text/plain', 'C:\\fakepath\\a.png', 'hello', 'a.png,b.txt'])
  web.run(`document.getElementById('f').value = ''; out = [document.getElementById('f').files.length]`)
  assert.deepEqual(web.json('out'), [0])
})

test('<input type=file>: a cancelled chooser (or none) fires cancel and keeps the files; showPicker opens it too', async () => {
  using web = await page('<!doctype html><html><body><input id="f" type="file"></body></html>')
  web.run(`globalThis.out = []; const f = document.getElementById('f')
    f.addEventListener('cancel', () => out.push('cancel')); f.addEventListener('change', () => out.push('change'))
    f.click()`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['cancel'])
  const c = chooser({ open: null }, new Map())
  web.internals.env.files = c.files
  web.run(`out = []; document.getElementById('f').showPicker()`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['cancel'])
  assert.equal(c.asked.length, 1)
})

test('showOpenFilePicker / showSaveFilePicker: handles over the picked files; cancelled is an AbortError', async () => {
  using web = await page()
  const files = new Map([['/home/u/notes.md', new TextEncoder().encode('# notes')]])
  const c = chooser({ open: ['/home/u/notes.md'], save: '/home/u/out.json' }, files)
  web.internals.env.files = c.files
  web.internals.env.fileType = systemType
  web.run(`globalThis.out = []; (async () => {
    const [handle] = await showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] })
    const file = await handle.getFile()
    out.push(handle.kind, handle.name, file.name, file.type, await file.text())
    const saved = await showSaveFilePicker({ suggestedName: 'out.json' })
    const w = await saved.createWritable()
    await w.write('{"a":'); await w.write(new TextEncoder().encode('1}')); await w.close()
    out.push(saved.name)
  })().catch((e) => out.push('error ' + e.name))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['file', 'notes.md', 'notes.md', 'text/markdown', '# notes', 'out.json'])
  assert.equal(new TextDecoder().decode(files.get('/home/u/out.json')), '{"a":1}')
  const filters = [{ name: 'Markdown', globs: ['*.md'], mimes: ['text/markdown'] }]
  assert.deepEqual(JSON.parse(JSON.stringify(c.asked)), [{ multiple: false, directory: false, filters }, { name: 'out.json', filters: [] }])
  web.internals.env.files = null
  web.run(`out = []; showOpenFilePicker().catch((e) => out.push(e.name, e instanceof DOMException))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['AbortError', true])
})

test('showDirectoryPicker: a directory handle over the picked folder (entries, get, create, remove, resolve); cancelled is an AbortError', async () => {
  using web = await page()
  const enc = (text: string) => new TextEncoder().encode(text)
  const files = new Map<string, Node>([
    ['/home/u/Notes', 'dir'],
    ['/home/u/Notes/a.md', enc('# a')],
    ['/home/u/Notes/sub', 'dir'],
    ['/home/u/Notes/sub/b.md', enc('b')],
    ['/home/u/Notes/link', 'link'],
  ])
  const c = chooser({ directory: '/home/u/Notes' }, files)
  web.internals.env.files = c.files
  web.run(`globalThis.out = []; (async () => {
    const dir = await showDirectoryPicker({ id: 'notes', mode: 'readwrite', startIn: 'documents' })
    out.push(dir.kind, dir.name, dir instanceof FileSystemDirectoryHandle, dir instanceof FileSystemHandle, Object.prototype.toString.call(dir))
    const seen = []
    for await (const [name, handle] of dir) seen.push(name + ':' + handle.kind)
    out.push(seen.sort().join())
    const keys = []; for await (const key of dir.keys()) keys.push(key)
    out.push(keys.sort().join())
    const a = await dir.getFileHandle('a.md')
    out.push(await (await a.getFile()).text())
    const sub = await dir.getDirectoryHandle('sub')
    out.push(JSON.stringify(await dir.resolve(await sub.getFileHandle('b.md'))), await dir.resolve(dir).then((r) => r.length), await sub.resolve(a))
    const made = await dir.getFileHandle('new.txt', { create: true })
    const w = await made.createWritable(); await w.write('fresh'); await w.close()
    const deeper = await sub.getDirectoryHandle('deeper', { create: true })
    out.push(deeper.kind, await made.isSameEntry(await dir.getFileHandle('new.txt')), await made.isSameEntry(a))
    for (const [what, call] of [
      ['missing', () => dir.getFileHandle('nope.md')],
      ['file as dir', () => dir.getDirectoryHandle('a.md')],
      ['dir as file', () => dir.getFileHandle('sub')],
      ['link', () => dir.getFileHandle('link')],
      ['bad name', () => dir.getFileHandle('../x')],
      ['not empty', () => dir.removeEntry('sub')],
      ['remove missing', () => dir.removeEntry('nope')],
    ]) await call().then(() => out.push(what + ' ok'), (e) => out.push(what + ' ' + e.name))
    await dir.removeEntry('sub', { recursive: true })
    await dir.removeEntry('a.md')
    out.push(await a.getFile().then(() => 'still', (e) => e.name))
    out.push(await dir.queryPermission({ mode: 'readwrite' }))
    const read = await showDirectoryPicker()
    out.push(await read.queryPermission({ mode: 'readwrite' }), await read.requestPermission({ mode: 'readwrite' }), await read.queryPermission())
    await read.getFileHandle('x.md', { create: true }).catch((e) => out.push('read-only create ' + e.name))
    await (await read.getFileHandle('new.txt')).createWritable().catch((e) => out.push('read-only write ' + e.name))
    await showDirectoryPicker({ mode: 'write' }).catch((e) => out.push('mode ' + e.name))
    await showDirectoryPicker({ id: 'no spaces' }).catch((e) => out.push('id ' + e.name))
  })().catch((e) => out.push('error ' + e.name + ' ' + e.message))`)
  await web.wait(10)
  assert.deepEqual(web.json('out'), [
    'directory', 'Notes', true, true, '[object FileSystemDirectoryHandle]',
    'a.md:file,sub:directory',
    'a.md,sub',
    '# a',
    '["sub","b.md"]', 0, null,
    'directory', true, false,
    'missing NotFoundError', 'file as dir TypeMismatchError', 'dir as file TypeMismatchError', 'link TypeMismatchError', 'bad name TypeError',
    'not empty InvalidModificationError', 'remove missing NotFoundError',
    'NotFoundError',
    'granted',
    'prompt', 'denied', 'granted',
    'read-only create NotAllowedError', 'read-only write NotAllowedError',
    'mode TypeError', 'id TypeError',
  ])
  assert.equal(new TextDecoder().decode(files.get('/home/u/Notes/new.txt') as Uint8Array), 'fresh')
  assert.deepEqual([...files.keys()].sort(), ['/home/u/Notes', '/home/u/Notes/link', '/home/u/Notes/new.txt'])
  assert.deepEqual(JSON.parse(JSON.stringify(c.asked)), [{ mode: 'readwrite' }, { mode: 'read' }])
  web.internals.env.files = null
  web.run(`out = []; showDirectoryPicker().catch((e) => out.push(e.name, e instanceof DOMException))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['AbortError', true])
})

test('Notification: granted where the host shows them; the page gets show', async () => {
  using web = await page()
  const shown: unknown[] = []
  web.internals.env.notify = (notification) => void shown.push(notification)
  web.run(`globalThis.out = [Notification.permission]
    Notification.requestPermission().then((p) => out.push(p))
    const n = new Notification('Build done', { body: '3 files', icon: 'icon.png', tag: 'build' })
    n.onshow = () => out.push('show')`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['granted', 'granted', 'show'])
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), [{ title: 'Build done', body: '3 files', icon: 'http://acde.local/icon.png', tag: 'build' }])
})

test('beforeunload: preventDefault, a returnValue or an answering onbeforeunload cancel it', async () => {
  using web = await page()
  const fire = () => web.run<boolean>(`dispatchEvent(new BeforeUnloadEvent('beforeunload', { cancelable: true }))`)
  assert.equal(fire(), true)
  web.run(`globalThis.h = (e) => { e.returnValue = 'unsaved' }; addEventListener('beforeunload', h)`)
  assert.equal(fire(), false)
  web.run(`removeEventListener('beforeunload', h); onbeforeunload = () => 'unsaved'`)
  assert.equal(fire(), false)
  web.run(`onbeforeunload = () => undefined`)
  assert.equal(fire(), true)
  web.run(`addEventListener('beforeunload', (e) => e.preventDefault(), { once: true })`)
  assert.equal(fire(), false)
  assert.equal(web.run(`new BeforeUnloadEvent('beforeunload').returnValue`), '')
})

test('visibility follows the host (document.hidden, visibilitychange); navigator.language from the options', async () => {
  using web = await page('<!doctype html><html><body></body></html>', { language: 'en-US', languages: ['en-US', 'en'] })
  web.run(`globalThis.out = []; document.addEventListener('visibilitychange', () => out.push(document.visibilityState, document.hidden))`)
  web.internals.setVisible(false)
  web.internals.setVisible(false)
  web.internals.setVisible(true)
  assert.deepEqual(web.json('out'), ['hidden', true, 'visible', false])
  assert.deepEqual(web.json('[navigator.language, navigator.languages]'), ['en-US', ['en-US', 'en']])
})

test('live tag collections, location after pushState, validity, anchors, constants and canvas setters', async () => {
  using web = await page('<!doctype html><html><body><img id="i"><form id="f"><input id="x" required></form></body></html>')
  web.run(`const imgs = document.images, tags = document.getElementsByTagName('img')
    const before = [imgs.length, tags.length]
    document.getElementById('i').setAttribute('alt', 'a')
    const img = document.createElement('img'); document.body.append(img)
    const after = [imgs.length, tags.length]
    img.remove()
    after.push(imgs.length, tags.length)
    history.pushState(null, '', '/a/b?q=1#h')
    const loc = [location.pathname, location.search, location.hash, location.origin]
    history.replaceState(null, '', '/c')
    loc.push(location.pathname, location.hash)
    const x = document.getElementById('x')
    const v = [x.validity.valueMissing, x.validity.valid, x.validationMessage]
    x.value = 'ok'
    v.push(x.validity.valueMissing, x.validity.valid)
    const a = document.createElement('a'); a.href = '/p?z'; a.rel = 'noopener'; a.text = 'link'
    const link = [a.href, a.search, a.textContent, a.relList.contains('noopener'), a.nonce, a.autofocus]
    a.nonce = 'n'; a.autofocus = true
    link.push(a.getAttribute('nonce'), a.hasAttribute('autofocus'))
    link.push(Object.keys(Node.prototype).includes('ELEMENT_NODE'), KeyboardEvent.prototype.DOM_KEY_LOCATION_NUMPAD)
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(NaN, 1); ctx.arc(5, 5, 2, 0, 1); ctx.roundRect(0, 0, 4, 4, [1, 2])
    ctx.lineCap = 'round'; ctx.lineCap = 'nope'; ctx.shadowBlur = -1; ctx.shadowOffsetX = 3
    globalThis.out = { before, after, loc, v, link, canvas: [ctx.lineCap, ctx.shadowBlur, ctx.shadowOffsetX] }`)
  assert.deepEqual(web.json('out'), {
    before: [1, 1],
    after: [2, 2, 1, 1],
    loc: ['/a/b', '?q=1', '#h', 'http://acde.local', '/c', ''],
    v: [true, false, 'Please fill out this field.', false, true],
    link: ['http://acde.local/p?z', '?z', 'link', true, '', false, 'n', true, true, 3],
    canvas: ['round', 0, 3],
  })
})

test('MediaQueryList: a list without change listeners is no longer watched', async () => {
  using web = await page()
  web.run(`globalThis.out = []
    const mq = matchMedia('(min-width: 1px)')
    const f = () => out.push('change')
    mq.addEventListener('change', f)
    mq.removeEventListener('change', f)
    mq.onchange = f
    mq.onchange = null`)
  web.internals.mediaChanged()
  assert.deepEqual(web.json('out'), [])
})

test('navigator languages follow the session: languagechange on window', async () => {
  using web = await page('<!doctype html><html><body></body></html>', { language: 'en-US', languages: ['en-US', 'en'] })
  web.run(`globalThis.seen = []; addEventListener('languagechange', (e) => seen.push([e.type, e.bubbles, navigator.language, navigator.languages.join()]))`)
  web.internals.setLanguages({ language: 'zh-CN', languages: ['zh-CN', 'zh'] })
  web.internals.setLanguages({ language: 'zh-CN', languages: ['zh-CN', 'zh'] })
  assert.deepEqual(web.json(`seen`), [['languagechange', false, 'zh-CN', 'zh-CN,zh']])
})

test('canvas: setting width or height resets the 2d state right away, not at the next draw', async () => {
  using web = await page()
  web.run(`const c = document.createElement('canvas'); const ctx = c.getContext('2d')
    ctx.fillStyle = '#ff0000'; ctx.lineWidth = 4; ctx.fillRect(0, 0, 1, 1)
    c.width = 640; const reset = [ctx.fillStyle, ctx.lineWidth]
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 640, 150)
    globalThis.out = [...reset, ctx.fillStyle]`)
  assert.deepEqual(web.json('out'), ['#000000', 1, '#ffffff'])
})

test('navigator.storage: getDirectory() is a read-write root named "" from the page\'s file channel; persist and estimate', async () => {
  using web = await page()
  const files = new Map<string, Node>([['/opfs', 'dir']])
  web.internals.env.files = chooser({ private: '/opfs' }, files).files
  const out = await web.run<Promise<unknown>>(`(async () => {
    const root = await navigator.storage.getDirectory()
    const file = await root.getFileHandle('a.txt', { create: true })
    const w = await file.createWritable(); await w.write('private'); await w.close()
    const storage = navigator.storage
    return [root.name, root.kind, await root.queryPermission({ mode: 'readwrite' }), await (await file.getFile()).text(),
      await storage.persisted(), await storage.persist(), JSON.stringify(await storage.estimate()), storage instanceof StorageManager]
  })()`)
  assert.deepEqual(JSON.parse(JSON.stringify(out)), ['', 'directory', 'granted', 'private', true, true, '{"usage":0,"quota":0}', true])
  assert.equal(new TextDecoder().decode(files.get('/opfs/a.txt') as Uint8Array), 'private')
})

test('fetch bodies: a null body is never used, reading locks the stream, clone keeps error responses, credentials in URLs throw', async () => {
  using web = await page()
  const out = await web.run<Promise<unknown>>(`(async () => {
    const empty = new Response(null); await empty.text()
    const full = new Response('x'); await full.text()
    const error = Response.error().clone()
    let credentials = 'made'
    try { new Request('https://user:pw@example.com/') } catch (e) { credentials = e.constructor.name }
    return JSON.stringify([empty.bodyUsed, full.bodyUsed, full.body.locked, error.status, error.type, credentials])
  })()`)
  assert.deepEqual(JSON.parse(out as string), [false, true, true, 0, 'error', 'TypeError'])
})

test('picked and dropped files: File.type is the type the host system gives the name, empty when it knows none', async () => {
  using web = await page()
  const enc = (text: string) => new TextEncoder().encode(text)
  const files = new Map<string, Node>([['/drop/photo.PNG', enc('PNG')], ['/drop/notes.md', enc('# n')], ['/drop/data.xyz', enc('x')]])
  web.internals.env.files = chooser({ open: ['/drop/photo.PNG', '/drop/data.xyz'] }, files).files
  const { handles } = web.internals
  const transfer = web.run<object>('globalThis.dt = new DataTransfer(); dt')
  for (const path of files.keys()) handles.transfer(transfer, null, handles.of({ name: path.slice('/drop/'.length), path }, 'file', 'read'))
  web.run(`globalThis.out = []
    globalThis.dropped = () => Promise.all([...dt.items].map(async (i) => (await (await i.getAsFileSystemHandle()).getFile()).type))`)
  web.run(`dropped().then((types) => out.push(types))`)
  await web.wait(5)
  const asked: string[] = []
  web.internals.env.fileType = (name) => (asked.push(name), systemType(name))
  web.run(`dropped().then((types) => out.push(types))
    .then(() => showOpenFilePicker({ multiple: true })).then((hs) => Promise.all(hs.map((h) => h.getFile())))
    .then((picked) => out.push(picked.map((f) => [f.name, f.type])))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), [
    ['', '', ''],
    ['image/png', 'text/markdown', ''],
    [['photo.PNG', 'image/png'], ['data.xyz', '']],
  ])
  assert.deepEqual(asked.sort(), ['data.xyz', 'data.xyz', 'notes.md', 'photo.PNG', 'photo.PNG'])
})

test('DataTransferItemList: items[i] and length like the web platform, undefined past the end, live and iterable', async () => {
  using web = await page()
  web.run(`globalThis.out = []
    const dt = new DataTransfer(); const items = dt.items
    dt.setData('text/plain', 'hi'); items.add(new File(['x'], 'x.txt', { type: 'text/plain' }))
    out.push(items.length, items[0].kind, items[0].type, items[1].kind, items[1].getAsFile().name, items[2] === undefined, items[-1] === undefined)
    out.push(items[1] === items[1], items['1'] === items[1], 0 in items, 2 in items, Object.keys(items).join(), [...items].map((i) => i.kind).join())
    out.push([...items][0] === items[0], items instanceof DataTransferItemList, String(items))
    items[0] = 'replaced'; items.remove(0)
    out.push(items.length, items[0].kind, items[1] === undefined, dt.items === items)
    items.remove(0)
    out.push(items.length, items[0] === undefined, 0 in items)`)
  assert.deepEqual(web.json('out'), [
    2, 'string', 'text/plain', 'file', 'x.txt', true, true,
    true, true, true, false, '0,1', 'string,file',
    true, true, '[object DataTransferItemList]',
    1, 'file', true, true,
    0, true, false,
  ])
})

test('DataTransferItemList.clear() removes strings and files; clearData() leaves the files', async () => {
  using web = await page()
  web.run(`globalThis.out = []
    const dt = new DataTransfer(); const items = dt.items
    const fill = () => { dt.setData('text/plain', 'hi'); dt.setData('text/uri-list', 'https://a.example/'); items.add(new File(['x'], 'x.txt')) }
    fill(); const before = dt.files
    dt.clearData()
    out.push(items.length, items[0].kind, dt.files.length, [...dt.types])
    fill(); items.clear()
    out.push(items.length, items[0] === undefined, 0 in items, dt.files.length, [...dt.types], dt.getData('text/plain'), before.length)
    items.add('again', 'text/plain')
    out.push(items.length, items[0].kind, dt.getData('text/plain'))`)
  assert.deepEqual(web.json('out'), [
    1, 'file', 1, ['Files'],
    0, true, false, 0, [], '', 1,
    1, 'string', 'again',
  ])
})

test('drops: files and getAsFileSystemHandle() give read-only handles; folders and strings come as items only', async () => {
  using web = await page()
  const enc = (text: string) => new TextEncoder().encode(text)
  const files = new Map<string, Node>([['/drop/a.txt', enc('alpha')], ['/drop/b.md', enc('# beta')], ['/drop/dir', 'dir'], ['/drop/dir/c.txt', enc('c')]])
  web.internals.env.files = chooser({}, files).files
  const { handles } = web.internals
  const transfer = web.run<object>('globalThis.dt = new DataTransfer(); dt.setData("text/uri-list", "file:///drop/a.txt"); dt')
  for (const [path, text] of [['/drop/a.txt', 'alpha'], ['/drop/b.md', '# beta']] as const) {
    const name = path.slice('/drop/'.length)
    const file = web.run<object>(`new File([${JSON.stringify(text)}], ${JSON.stringify(name)})`)
    handles.transfer(transfer, file, handles.of({ name, path }, 'file', 'read'))
  }
  handles.transfer(transfer, null, handles.of({ name: 'dir', path: '/drop/dir' }, 'directory', 'read'))
  web.run(`globalThis.out = []; (async () => {
    out.push([...dt.types], dt.files.length, [...dt.files].map((f) => f.name), dt.items.length)
    const items = [...dt.items]
    out.push(items.map((i) => i.kind), items.map((i) => i.getAsFile()?.name ?? null))
    const got = await Promise.all(items.map((i) => i.getAsFileSystemHandle()))
    out.push(got.map((h) => h && [h.kind, h.name, h instanceof FileSystemHandle]))
    out.push(await (await got[1].getFile()).text(), await (await got[2].getFile()).text())
    out.push(await got[1].queryPermission({ mode: 'readwrite' }), await got[1].queryPermission())
    out.push(await got[1].createWritable().then(() => 'writable', (e) => e.name))
    const names = []; for await (const [name, child] of got[3].entries()) names.push(name, child.kind)
    out.push(names, await got[3].getFileHandle('new.txt', { create: true }).then(() => 'created', (e) => e.name))
    const own = new DataTransfer(); own.items.add(new File(['x'], 'x.txt'))
    out.push(await own.items[Symbol.iterator]().next().value.getAsFileSystemHandle())
  })().catch((e) => out.push('error ' + e.name + ' ' + e.message))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), [
    ['text/uri-list', 'Files'], 2, ['a.txt', 'b.md'], 4,
    ['string', 'file', 'file', 'file'], [null, 'a.txt', 'b.md', null],
    [null, ['file', 'a.txt', true], ['file', 'b.md', true], ['directory', 'dir', true]],
    'alpha', '# beta',
    'prompt', 'granted',
    'NotAllowedError',
    ['c.txt', 'file'], 'NotAllowedError',
    null,
  ])
})

test('handles handed over for writing (open requests, pickers): createWritable writes back; read-only picks are refused', async () => {
  using web = await page()
  const files = new Map<string, Node>([['/home/u/doc.txt', new TextEncoder().encode('old')], ['/home/u/locked.txt', new TextEncoder().encode('ro')]])
  const c = chooser({ open: ['/home/u/locked.txt'] }, files)
  web.internals.env.files = { ...c.files, open: async () => [{ name: 'locked.txt', path: '/home/u/locked.txt', writable: false }] }
  const handle = web.internals.handles.of({ name: 'doc.txt', path: '/home/u/doc.txt' }, 'file', 'readwrite')
  ;(web.context as Record<string, unknown>)['given'] = handle
  web.run(`globalThis.out = []; (async () => {
    out.push(given instanceof FileSystemFileHandle, await given.queryPermission({ mode: 'readwrite' }))
    const w = await given.createWritable(); await w.write('new'); await w.close()
    const [locked] = await showOpenFilePicker()
    out.push(await locked.queryPermission({ mode: 'readwrite' }), await locked.createWritable().then(() => 'writable', (e) => e.name))
  })().catch((e) => out.push('error ' + e.name + ' ' + e.message))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), [true, 'granted', 'prompt', 'NotAllowedError'])
  assert.equal(new TextDecoder().decode(files.get('/home/u/doc.txt') as Uint8Array), 'new')
  const picked = JSON.parse(JSON.stringify(web.internals.handles.picked(handle)))
  assert.deepEqual(picked, { name: 'doc.txt', path: '/home/u/doc.txt', kind: 'file', mode: 'readwrite' })
  assert.equal(web.internals.handles.picked({ name: 'doc.txt', path: '/etc/passwd' }), null)
})

function rangedFiles(files: Map<string, Node>, calls: string[]) {
  const versions = new Map<string, number>()
  const open = new Map<string, { path: string; bytes: Uint8Array }>()
  const version = (path: string) => `v${versions.get(path) ?? 0}`
  const conflict = () => Object.assign(new Error('file changed'), { code: 'ECONFLICT' })
  return {
    touch: (path: string) => void versions.set(path, (versions.get(path) ?? 0) + 1),
    open,
    ranged: {
      wholeLimit: 16,
      chunkLimit: 8,
      readRange: async (file: { path: string }, offset: number, length: number, expected: string | null) => {
        const node = files.get(file.path)
        if (!ArrayBuffer.isView(node)) return null
        if (expected !== null && expected !== version(file.path)) throw conflict()
        calls.push(`read ${offset}+${length}`)
        const bytes = node.slice(Math.min(offset, node.length), Math.min(offset + length, node.length))
        return { bytes, size: node.length, lastModified: 1000, version: version(file.path) }
      },
      openWrite: async (file: { path: string }, keep: boolean) => {
        const node = files.get(file.path)
        const bytes = keep && ArrayBuffer.isView(node) ? node.slice() : new Uint8Array(0)
        const id = `w${open.size + 1}`
        open.set(id, { path: file.path, bytes })
        return { id, size: bytes.length }
      },
      writeChunk: async (id: string, offset: number, chunk: Uint8Array) => {
        if (chunk.length > 8) throw new Error('chunk too large')
        calls.push(`write ${offset}+${chunk.length}`)
        const session = open.get(id)!
        const grown = new Uint8Array(Math.max(session.bytes.length, offset + chunk.length))
        grown.set(session.bytes)
        grown.set(chunk, offset)
        session.bytes = grown
      },
      truncateWrite: async (id: string, size: number) => {
        const session = open.get(id)!
        const sized = new Uint8Array(size)
        sized.set(session.bytes.subarray(0, size))
        session.bytes = sized
      },
      commitWrite: async (id: string) => {
        const session = open.get(id)!
        files.set(session.path, session.bytes)
        open.delete(id)
      },
      abortWrite: async (id: string) => void open.delete(id),
    },
  }
}

test('file handles read large files in ranges and write them in chunks committed on close', async () => {
  using web = await page()
  const big = new Uint8Array(40).map((_, i) => 65 + (i % 26))
  const files = new Map<string, Node>([['/home/u/big.bin', big], ['/home/u/small.txt', new TextEncoder().encode('small')]])
  const calls: string[] = []
  const r = rangedFiles(files, calls)
  web.internals.env.files = { ...chooser({}, files).files, ranged: r.ranged }
  const handle = (path: string) => web.internals.handles.of({ name: path.split('/').pop()!, path }, 'file', 'readwrite')
  Object.assign(web.context as Record<string, unknown>, { bigHandle: handle('/home/u/big.bin'), smallHandle: handle('/home/u/small.txt') })
  web.run(`globalThis.out = []; (async () => {
    const file = await bigHandle.getFile()
    out.push(file.size, await file.slice(24, 30).text())
    const chunks = []
    for await (const chunk of file.stream()) chunks.push(chunk.length)
    out.push(chunks.join(','), (await file.text()).slice(0, 3), await (async () => new Response(file.slice(1, 4)))().then(() => 'body', (e) => e.name))
    out.push(await (await smallHandle.getFile()).text())
    const w = await bigHandle.createWritable()
    await w.write('0123456789abcdefghij'); await w.write({ type: 'write', position: 24, data: new Blob(['XY']) })
    await w.close()
    const kept = await smallHandle.createWritable({ keepExistingData: true })
    await kept.truncate(3); await kept.write({ type: 'write', position: 5, data: '!' }); await kept.close()
    const dropped = await smallHandle.createWritable(); await dropped.write('gone'); await dropped.abort()
  })().catch((e) => out.push('error ' + e.name + ' ' + e.message))`)
  await web.wait(20)
  assert.deepEqual(web.json('out'), [40, 'YZABCD', '40', 'ABC', 'NotReadableError', 'small'])
  assert.deepEqual(calls.filter((call) => call.startsWith('write')), ['write 0+8', 'write 8+8', 'write 16+4', 'write 24+2', 'write 5+1', 'write 0+4'])
  assert.equal(new TextDecoder().decode(files.get('/home/u/big.bin') as Uint8Array), '0123456789abcdefghij\0\0\0\0XY')
  assert.equal(new TextDecoder().decode(files.get('/home/u/small.txt') as Uint8Array), 'sma\0\0!')
  assert.equal(r.open.size, 0)
  ;(web.context as Record<string, unknown>)['touch'] = () => r.touch('/home/u/big.bin')
  web.run(`out = []; bigHandle.getFile().then(async (file) => {
    out.push(await file.slice(0, 2).text())
    touch()
    await file.text().catch((e) => out.push(e.name))
  })`)
  await web.wait(10)
  assert.deepEqual(web.json('out'), ['01', 'NotReadableError'])
})

test('document.fonts lists the faces of @font-face rules and the ones added', async () => {
  const face = '@font-face { font-family: "Inter"; src: url(/inter.woff2); font-weight: 700 }'
  using web = await page(`<!doctype html><html><head><style>${face}</style></head><body></body></html>`)
  const out = web.run(`const faces = () => [...document.fonts].map((f) => f.family + ':' + f.weight + ':' + f.status)
    const first = faces()
    const same = [...document.fonts][0] === [...document.fonts][0]
    document.fonts.add(new FontFace('Extra', 'url(/x.woff2)'))
    JSON.stringify({ first, same, size: document.fonts.size, all: faces() })`)
  assert.deepEqual(JSON.parse(out as string), { first: ['Inter:700:loaded'], same: true, size: 2, all: ['Inter:700:loaded', 'Extra:normal:unloaded'] })
})

test('CSS.supports asks render: a condition text or a property and a value; no argument throws', async () => {
  using web = await page()
  assert.equal(web.run('CSS.supports("display", "grid")'), true)
  assert.equal(web.run('CSS.supports("no-such-property", "zzz")'), false)
  assert.equal(web.run('CSS.supports("(display: grid) and (not (display: nope))")'), true)
  assert.equal(web.run('CSS.supports("selector(:nope)")'), false)
  assert.equal(web.run('CSS.supports(1, 2)'), false)
  assert.deepEqual(web.dom.supported, [
    ['display', 'grid'],
    ['no-such-property', 'zzz'],
    ['condition', '(display: grid) and (not (display: nope))'],
    ['condition', 'selector(:nope)'],
    ['1', '2'],
  ])
  assert.equal(web.run('try { CSS.supports() } catch (e) { e instanceof TypeError }'), true)
})

test('getBBox of SVG shapes and groups comes from their geometry, also after a script sets it', async () => {
  using web = await page(`<!doctype html><html><body><svg width="200" height="200">
    <g id="g" transform="translate(10 20)"><rect id="r" x="5" y="6" width="30" height="40"/><circle cx="100" cy="100" r="10"/></g>
    <path id="p"/><path id="arc" d="M0 50 A50 50 0 0 1 100 50"/><path id="curve" d="M0 0 C0 100 100 100 100 0"/>
    <polygon id="poly" points="1,2 9,4 5,8"/></svg></body></html>`)
  const out = web.run(`const round = (v) => Math.round(v * 100) / 100
    const box = (id) => { const b = document.getElementById(id).getBBox(); return [b.x, b.y, b.width, b.height].map(round) }
    const empty = box('p')
    document.getElementById('p').setAttribute('d', 'M130 113 l4 -3 L138 106 H150 v10 z')
    JSON.stringify({ r: box('r'), g: box('g'), empty, p: box('p'), arc: box('arc'), curve: box('curve'), poly: box('poly') })`)
  assert.deepEqual(JSON.parse(out as string), {
    r: [5, 6, 30, 40],
    g: [5, 6, 105, 104],
    empty: [0, 0, 0, 0],
    p: [130, 106, 20, 10],
    arc: [0, 0, 100, 50],
    curve: [0, 0, 100, 75],
    poly: [1, 2, 8, 6],
  })
})
