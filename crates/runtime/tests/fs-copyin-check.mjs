// Finder.copyIn: a local file (absolute path or file:// URI) copied into a directory of a workspace root, any size
// and content, under its own name or the first free "名字 N.ext". No TS counterpart (new API): the expected values
// are written here.
// Usage: run.sh <acde> fs-copyin-check.mjs
import { Checks, env, failure, join, native, run, sys, tempDir } from './check.mjs'

const t = new Checks()
const base = tempDir('acde-copyin-')
// ~/agentos-work is a root when it exists (run.sh gives the check a HOME of its own)
const ws = join(env.HOME, 'agentos-work'), src = join(base, 'src dir')
sys.mkdir(join(ws, 'docs'))
sys.mkdir(src)
sys.writeFile(join(ws, 'docs', 'plain.txt'), 'x')
const finder = new native.Finder()

const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255])
sys.writeFile(join(src, '截图 1.png'), image)
sys.writeFile(join(src, '.env'), 'A=1\n')
sys.writeFile(join(src, 'README'), 'readme\n')

let entry = await finder.copyIn(ws, 'docs', join(src, '截图 1.png'))
t.check('first copy keeps the name', [entry.name, entry.kind, entry.size], ['截图 1.png', 'file', image.length])
t.check('bytes are the same', sys.readFile(join(ws, 'docs', '截图 1.png')), image)
entry = await finder.copyIn(ws, 'docs', encodeURI(`file://${join(src, '截图 1.png')}`))
t.check('file:// URI, name taken -> 名字 2.ext', entry.name, '截图 1 2.png')
entry = await finder.copyIn(ws, 'docs', join(src, '截图 1.png'))
t.check('then 名字 3.ext', entry.name, '截图 1 3.png')
t.check('dotfile: no extension', [(await finder.copyIn(ws, '', join(src, '.env'))).name, (await finder.copyIn(ws, '', join(src, '.env'))).name], ['.env', '.env 2'])
t.check('no extension', [(await finder.copyIn(ws, '', join(src, 'README'))).name, (await finder.copyIn(ws, '', join(src, 'README'))).name], ['README', 'README 2'])
t.check('existing file untouched', sys.readText(join(ws, 'docs', 'plain.txt')), 'x')
// beyond the 64 MiB read limit: copied all the same (sparse, so the test stays small on disk)
run('truncate', '-s', `${70 * 1024 * 1024}`, join(src, 'big.bin'))
entry = await finder.copyIn(ws, '', join(src, 'big.bin'))
t.check('70 MiB file', [entry.name, sys.stat(join(ws, 'big.bin')).size], ['big.bin', 70 * 1024 * 1024])
const error = async (p) => {
  const f = await failure(p)
  return f && { status: f.status, message: f.message }
}
t.check('missing source', await error(finder.copyIn(ws, '', join(src, 'nope.png'))), { status: 404, message: 'source file not found' })
t.check('directory source', await error(finder.copyIn(ws, '', src)), { status: 400, message: 'only regular files can be copied in' })
t.check('relative source', await error(finder.copyIn(ws, '', 'relative.png')), { status: 400, message: 'source must be an absolute path or a file:// URI' })
t.check('foreign URI', await error(finder.copyIn(ws, '', 'file://elsewhere/x.png')), { status: 400, message: 'not a file:// URI of this machine' })
t.check('target is a file', await error(finder.copyIn(ws, 'docs/plain.txt', join(src, 'README'))), { status: 400, message: 'not a directory' })
t.check('target escapes', await error(finder.copyIn(ws, '../', join(src, 'README'))), { status: 400, message: 'path escapes the workspace' })
t.check('target missing', await error(finder.copyIn(ws, 'nope', join(src, 'README'))), { status: 404, message: 'no such file or directory' })
t.check('nothing half-written', sys.exists(join(ws, 'nope')), false)

// the rest of the Finder on the same root (one root lookup per call): state, list, preview, rename, delete
await finder.place(ws, 'docs', 'docs/plain.txt')
const state = await finder.state()
t.check('state: the place, its listing and preview', [state.root, state.path, state.entries.map((e) => e.name), state.preview?.content], [ws, 'docs', ['plain.txt', '截图 1 2.png', '截图 1 3.png', '截图 1.png'], 'x'])
t.check('rename', (await finder.rename(ws, 'docs/plain.txt', 'docs/renamed.txt')).name, 'renamed.txt')
t.check('rename onto an existing file', await error(finder.rename(ws, 'docs/renamed.txt', 'README')), { status: 409, message: 'target already exists' })
t.check('openPath', await finder.openPath(ws, 'docs/renamed.txt'), { root: ws, path: 'docs/renamed.txt', file: sys.realpath(join(ws, 'docs', 'renamed.txt')) })
t.check('openPath: hidden', await error(finder.openPath(ws, '.env')), { status: 400, message: 'hidden files and folders are not opened in the browser' })
t.check('delete', await finder.delete(ws, 'docs/renamed.txt'), { status: 'deleted', path: 'docs/renamed.txt' })
const remembered = JSON.parse(sys.readText(join(env.HOME, '.local/state/acde/finder-place.json')))
t.check('the place is remembered on disk', remembered, { root: ws, path: 'docs', file: 'docs/plain.txt' })
const again = await new native.Finder().state()
t.check('a new Finder starts there', [again.root, again.path], [ws, 'docs'])

sys.remove(base, true)
sys.remove(ws, true)
t.done()
