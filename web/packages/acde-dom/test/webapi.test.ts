import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWeb } from './harness.ts'

const PAGE = '<!doctype html><html><body><a id="frag" href="#part">to part</a><div style="height:3000px"></div><h2 id="part">Part</h2></body></html>'

test('links: a fragment moves location.hash (hashchange); other URLs and new windows go to the host', async () => {
  const web = createWeb()
  await web.internals.loadPage(PAGE)
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
  web.close()
})

test('links: <a download>, blob: and data: URLs are saved through the host (the blob taken at the click)', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
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
  web.close()
})

type Node = Uint8Array | 'dir' | 'link'

function chooser(answer: { open?: string[] | null; save?: string | null; directory?: string | null }, files: Map<string, Node>) {
  const asked: unknown[] = []
  const name = (path: string) => path.split('/').pop()!
  const kind = (node: Node | undefined) => (node === undefined ? null : node === 'dir' ? ('directory' as const) : node === 'link' ? ('other' as const) : ('file' as const))
  const under = (dir: string) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`))
  return {
    asked,
    files: {
      open: async (options: unknown) => (asked.push(options), answer.open ? answer.open.map((path) => ({ name: name(path), path })) : null),
      save: async (options: unknown) => (asked.push(options), answer.save ? { name: name(answer.save), path: answer.save } : null),
      read: async (file: { path: string }) => {
        const node = files.get(file.path)
        return node instanceof Uint8Array ? { bytes: node, lastModified: 1000 } : null
      },
      write: async (file: { path: string }, bytes: Uint8Array) => void files.set(file.path, bytes.slice()),
      directory: async (options: unknown) => (asked.push(options), answer.directory ? { name: name(answer.directory), path: answer.directory } : null),
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
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><form><input id="f" type="file" name="doc" accept=".png,image/jpeg" multiple></form></body></html>')
  const files = new Map([['/home/u/a.png', new TextEncoder().encode('PNG')], ['/home/u/b.txt', new TextEncoder().encode('hello')]])
  const c = chooser({ open: ['/home/u/a.png', '/home/u/b.txt'] }, files)
  web.internals.env.files = c.files
  web.run(`globalThis.out = []; const f = document.getElementById('f')
    f.addEventListener('input', () => out.push('input'))
    f.addEventListener('change', async () => {
      out.push('change', f.files.length, f.files[0].name, f.files[0].type, f.files[1].type, f.value, await f.files[1].text())
      out.push(new FormData(f.form).getAll('doc').map((x) => x.name).join())
    })
    f.click()`)
  await web.wait(5)
  assert.deepEqual(JSON.parse(JSON.stringify(c.asked)), [{ multiple: true, directory: false, filters: [{ name: '.png, image/jpeg', globs: ['*.png'], mimes: ['image/jpeg'] }] }])
  assert.deepEqual(web.json('out'), ['input', 'change', 2, 'a.png', 'image/png', 'text/plain', 'C:\\fakepath\\a.png', 'hello', 'a.png,b.txt'])
  web.run(`document.getElementById('f').value = ''; out = [document.getElementById('f').files.length]`)
  assert.deepEqual(web.json('out'), [0])
  web.close()
})

test('<input type=file>: a cancelled chooser (or none) fires cancel and keeps the files; showPicker opens it too', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><input id="f" type="file"></body></html>')
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
  web.close()
})

test('showOpenFilePicker / showSaveFilePicker: handles over the picked files; cancelled is an AbortError', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  const files = new Map([['/home/u/notes.md', new TextEncoder().encode('# notes')]])
  const c = chooser({ open: ['/home/u/notes.md'], save: '/home/u/out.json' }, files)
  web.internals.env.files = c.files
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
  assert.deepEqual(JSON.parse(JSON.stringify(c.asked)), [{ multiple: false, directory: false, filters: [{ name: 'Markdown', globs: ['*.md'], mimes: ['text/markdown'] }] }, { name: 'out.json', filters: [] }])
  web.internals.env.files = null
  web.run(`out = []; showOpenFilePicker().catch((e) => out.push(e.name, e instanceof DOMException))`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['AbortError', true])
  web.close()
})

test('showDirectoryPicker: a directory handle over the picked folder (entries, get, create, remove, resolve); cancelled is an AbortError', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  const enc = (text: string) => new TextEncoder().encode(text)
  const files = new Map<string, Node>([['/home/u/Notes', 'dir'], ['/home/u/Notes/a.md', enc('# a')], ['/home/u/Notes/sub', 'dir'], ['/home/u/Notes/sub/b.md', enc('b')], ['/home/u/Notes/link', 'link']])
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
    'missing NotFoundError', 'file as dir TypeMismatchError', 'dir as file TypeMismatchError', 'link TypeMismatchError', 'bad name TypeError', 'not empty InvalidModificationError', 'remove missing NotFoundError',
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
  web.close()
})

test('Notification: granted where the host shows them; the page gets show', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  const shown: unknown[] = []
  web.internals.env.notify = (notification) => void shown.push(notification)
  web.run(`globalThis.out = [Notification.permission]
    Notification.requestPermission().then((p) => out.push(p))
    const n = new Notification('Build done', { body: '3 files', icon: 'icon.png', tag: 'build' })
    n.onshow = () => out.push('show')`)
  await web.wait(5)
  assert.deepEqual(web.json('out'), ['granted', 'granted', 'show'])
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), [{ title: 'Build done', body: '3 files', icon: 'http://acde.local/icon.png', tag: 'build' }])
  web.close()
})

test('beforeunload: preventDefault, a returnValue or an answering onbeforeunload cancel it', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
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
  web.close()
})

test('visibility follows the host (document.hidden, visibilitychange); navigator.language from the options', async () => {
  const web = createWeb({ language: 'en-US', languages: ['en-US', 'en'] })
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  web.run(`globalThis.out = []; document.addEventListener('visibilitychange', () => out.push(document.visibilityState, document.hidden))`)
  web.internals.setVisible(false)
  web.internals.setVisible(false)
  web.internals.setVisible(true)
  assert.deepEqual(web.json('out'), ['hidden', true, 'visible', false])
  assert.deepEqual(web.json('[navigator.language, navigator.languages]'), ['en-US', ['en-US', 'en']])
  web.close()
})

test('live tag collections, location after pushState, validity, anchors, constants and canvas setters', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body><img id="i"><form id="f"><input id="x" required></form></body></html>')
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
    link.push(a.getAttribute('nonce'), a.hasAttribute('autofocus'), Object.keys(Node.prototype).includes('ELEMENT_NODE'), KeyboardEvent.prototype.DOM_KEY_LOCATION_NUMPAD)
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
  web.close()
})

test('MediaQueryList: a list without change listeners is no longer watched', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  web.run(`globalThis.out = []
    const mq = matchMedia('(min-width: 1px)')
    const f = () => out.push('change')
    mq.addEventListener('change', f)
    mq.removeEventListener('change', f)
    mq.onchange = f
    mq.onchange = null`)
  web.internals.mediaChanged()
  assert.deepEqual(web.json('out'), [])
  web.close()
})

test('navigator languages follow the session: languagechange on window', async () => {
  const web = createWeb({ language: 'en-US', languages: ['en-US', 'en'] })
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  web.run(`globalThis.seen = []; addEventListener('languagechange', (e) => seen.push([e.type, e.bubbles, navigator.language, navigator.languages.join()]))`)
  web.internals.setLanguages({ language: 'zh-CN', languages: ['zh-CN', 'zh'] })
  web.internals.setLanguages({ language: 'zh-CN', languages: ['zh-CN', 'zh'] })
  assert.deepEqual(web.json(`seen`), [['languagechange', false, 'zh-CN', 'zh-CN,zh']])
  web.close()
})

test('canvas: setting width or height resets the 2d state right away, not at the next draw', async () => {
  const web = createWeb()
  await web.internals.loadPage('<!doctype html><html><body></body></html>')
  web.run(`const c = document.createElement('canvas'); const ctx = c.getContext('2d')
    ctx.fillStyle = '#ff0000'; ctx.lineWidth = 4; ctx.fillRect(0, 0, 1, 1)
    c.width = 640; const reset = [ctx.fillStyle, ctx.lineWidth]
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 640, 150)
    globalThis.out = [...reset, ctx.fillStyle]`)
  assert.deepEqual(web.json('out'), ['#000000', 1, '#ffffff'])
  web.close()
})
