import assert from 'node:assert/strict'
import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const artifacts = process.argv[2]
assert.ok(artifacts, 'Run this check through scripts/check-directory-picker.sh')
const run = resolve(artifacts)
const pkg = join(run, 'package')
const debug = join(run, 'debug')
const home = join(run, 'home')
const state = join(run, 'state')
const readDir = join(run, 'read-only')
const writeDir = join(run, 'read-write')
await Promise.all([pkg, debug, home, state, readDir, writeDir].map((path) => mkdir(path, { recursive: true })))
await Promise.all([
  Bun.write(join(readDir, 'fixture.txt'), 'selected folder'),
  Bun.write(join(pkg, 'package.json'), JSON.stringify({ name: 'picker-probe', acde: {
    apps: [
      { id: 'picker-probe', label: 'Picker Probe', icon: 'files',
        entry: '/picker/app.html', capabilities: { fs: { roots: [] }, openFiles: true } },
      { id: 'picker-viewer', label: 'Picker Viewer', icon: 'files',
        entry: '/picker/view.html', mimeTypes: ['text/plain', 'x-scheme-handler/https'] },
    ],
    assets: { '/picker/': ['.'] },
  } })),
  Bun.write(join(pkg, 'app.html'), '<!doctype html><title>Picker Probe</title>'),
  Bun.write(join(pkg, 'view.html'), '<!doctype html><title>Picker Viewer</title>'),
])

const env = { ...process.env }
delete env['ACDE_STORAGE']
delete env['ACDE_BACKEND']
delete env['ACDE_DEV']
const binary = process.platform === 'win32' ? 'acdert.exe' : 'acdert'
const runtime = env['ACDERT'] ?? resolve('target', 'release', binary)
const host = env['ACDE_APP'] ?? resolve('web/packages/acde-host/dist')
const child = Bun.spawn([runtime, 'app', 'picker-probe', '--seconds', '50'], {
  env: { ...env, ACDE_APP: host, ACDE_PATH: pkg, ACDE_DEBUG_DIR: debug, ACDE_HEADLESS: '1',
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: state },
  stdout: Bun.file(join(run, 'runtime.stdout.log')),
  stderr: Bun.file(join(run, 'runtime.stderr.log')),
})

async function call<T>(name: string, source: string): Promise<T> {
  const base = join(debug, name)
  await Bun.write(`${base}.tmp`, `export default ${source}`)
  await rename(`${base}.tmp`, `${base}.mjs`)
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const data = await Bun.file(`${base}.out`).json().catch(() => undefined) as
      { error?: string; value: T } | undefined
    if (data?.error) throw new Error(data.error)
    if (data) return data.value
    if (child.exitCode !== null) throw new Error(`acdert exited with ${child.exitCode} before ${name}`)
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${name}`)
}

const grant = join(state, 'acde', 'grants', 'picker-probe.json')

try {
  const id = await call<number>('wait-for-app', `async (api) => {
    for (let tries = 0; tries < 40; tries++) {
      const app = api.webs().find((web) => web.app === 'picker-probe')
      if (app && await api.web(app.name, 'document.title').catch(() => '') === 'Picker Probe') return app.window
      await api.sleep(100)
    }
    throw new Error('Picker app did not start')
  }`)
  const app = `picker-probe#${id}`
  const pick = <T>(name: string, path: string | null, source: string): Promise<T> => call(name, `async (api) => {
    api.shell.answerFolder(${JSON.stringify(path)})
    return api.web(${JSON.stringify(app)}, ${JSON.stringify(source)})
  }`)
  const cancel = await pick('cancel', null, `showDirectoryPicker().then(() => 'selected', (error) => error.name)`)
  assert.equal(cancel, 'AbortError')
  assert.equal(await Bun.file(grant).exists(), false)

  const read = await pick('read', readDir, `(async () => {
    const handle = await showDirectoryPicker()
    const file = await (await handle.getFileHandle('fixture.txt')).getFile()
    const blocked = await handle.getFileHandle('blocked.txt', { create: true })
      .then(() => 'created', (error) => error.name)
    const { fs } = await import('acde:fs')
    return { name: handle.name, text: await file.text(), blocked, roots: await fs.roots() }
  })()`)
  assert.deepEqual(read, { name: 'read-only', text: 'selected folder', blocked: 'NotAllowedError', roots: [] })
  assert.equal(await Bun.file(grant).exists(), false, 'Read-only selection must not persist a writable grant')
  console.log('Read-only choice permits reading and leaves the grant table untouched')

  const write = await pick('read-write', writeDir, `(async () => {
    const handle = await showDirectoryPicker({ mode: 'readwrite' })
    const writer = await (await handle.getFileHandle('saved.txt', { create: true })).createWritable()
    await writer.write('confirmed writable selection')
    await writer.close()
    const { fs } = await import('acde:fs')
    const roots = (await fs.roots()).map(({ path, label, mode }) => ({ path, label, mode }))
    const sibling = await fs.readText(${JSON.stringify(readDir)}, 'fixture.txt')
      .then(() => 'read', (error) => error.code)
    const location = await fs.locate(${JSON.stringify(join(writeDir, 'saved.txt'))})
    const outside = await fs.locate(${JSON.stringify(join(readDir, 'fixture.txt'))})
      .then(() => 'located', (error) => error.code)
    return { roots, sibling, location, outside }
  })()`)
  assert.deepEqual(write, {
    roots: [{ path: writeDir, label: 'read-write', mode: 'writable' }],
    sibling: 'EACCES',
    location: { root: writeDir, path: 'saved.txt' },
    outside: 'EACCES',
  })
  assert.deepEqual(await Bun.file(grant).json(), { roots: [writeDir] })
  assert.equal(await Bun.file(join(writeDir, 'saved.txt')).text(), 'confirmed writable selection')
  console.log('Explicit read/write choice creates a file and persists only that directory')
  console.log('Locate resolves a file within the granted folder and refuses a sibling directory')

  const file = join(writeDir, 'saved.txt')
  const targets = [file, file.replaceAll('\\', '/'), pathToFileURL(file).href, 'https://example.invalid/test']
  for (const [index, target] of targets.entries()) {
    const source = `(async () => {
      const { openPath } = await import('acde:openPath')
      return openPath(${JSON.stringify(target)})
    })()`
    const result = await call<{ kind: string; id: string; window: number }>(`open-${index}`, `async (api) => {
      const opened = await api.web(${JSON.stringify(app)}, ${JSON.stringify(source)})
      api.broker.closeWeb(opened.window)
      return opened
    }`)
    assert.equal(result.kind, 'acde')
    assert.equal(result.id, 'picker-viewer')
    assert.ok(result.window > 0)
  }
  console.log('Open dispatches native paths, file URLs and HTTPS URLs to their registered app')

  await call('close', `(api) => { setTimeout(() => api.broker.closeWeb(${id}), 100); return true }`)
  const timeout = new Promise<null>((done) => setTimeout(done, 8000, null).unref())
  assert.equal(await Promise.race([child.exited, timeout]), 0)
  const log = await Bun.file(join(run, 'runtime.stderr.log')).text()
  assert.match(log, /选择要读取的文件夹/)
  assert.match(log, /选择要授权读写的文件夹/)
} finally {
  if (child.exitCode === null) child.kill()
  await child.exited
}
