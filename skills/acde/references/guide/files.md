# Files and folders

There are three ways to read and write files:

1. **Standard file pickers**: `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, `<input type="file">`. No capability needed; you get whatever the user picks.
2. **`acde:fs`**: files by "root": the app's own private folder, shared folders the user approved (Downloads, Documents, ...), and folders the user picked. Suited to apps like file managers and editors. Requires the `fs` capability.
3. **Private storage**: `navigator.storage.getDirectory()` (OPFS), IndexedDB, `localStorage`, for the app's own data.

An app works with handles and root ids, not with absolute paths; only the desktop and its bundled system apps see paths.

## File pickers

They work just like in a browser:

```js
const [handle] = await window.showOpenFilePicker({
  types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
})
const text = await (await handle.getFile()).text()
```

- The dialog is the system's own (the open / save panel on macOS, the file dialog on Windows, the portal on Linux).
- Only this page can read and write the picked file.
- A folder picked with `showDirectoryPicker()` is also **granted to the app**: it shows up as a root in `acde:fs` (`source: 'granted'`) and is still there on the next launch. The default pick is read-only (the root has `mode: 'read_only'`); `showDirectoryPicker({ mode: 'readwrite' })` gives a writable one. Give it back with `fs.revoke(id)`.
- When the user cancels, the promise rejects with `AbortError`. A headless session has no dialog: a picker rejects with `AbortError` there too, unless a test answered it in advance (`chooseFiles`, `chooseFolder`, `chooseSaveFile`; see [Testing](testing.md)).

## acde:fs

```jsonc
{ "capabilities": { "fs": true } }
```

```js
import { fs } from 'acde:fs'

const roots = await fs.roots()
// [{ id: 'private', label: '…', source: 'private', mode: 'writable', reason: null, exists: true }]

await fs.writeFile('private', 'notes/todo.md', '- buy milk\n', { mkdirs: true })

const { entries } = await fs.list('private', 'notes')
const { text, modifiedMs } = await fs.readText('private', 'notes/todo.md')
await fs.writeFile('private', 'notes/todo.md', text + '- a new item\n', { ifModifiedMs: modifiedMs })
```

### Roots

The first argument of every call is a root's **`id`**, and the second is a path under that root. A root's `id` is an opaque name, not a path: `fs.list('/home/me/Downloads')` is rejected.

There are three kinds of root:

| `source` | `id` | What it is | How the app gets it |
| --- | --- | --- | --- |
| `private` | `private` | The app's own data folder, created on first use | `"fs": true` (or any `fs` value) |
| `place` | The place's name, such as `downloads` | A shared folder of the user | Name it in `fs.roots`; the user approves each one (see [Shared places](#shared-places)) |
| `granted` | `folder-` plus 16 hex digits | A folder the user picked | `showDirectoryPicker()` |

`roots()` returns one item per root the app can use now: `{id, label, source, mode, reason, exists}`, plus `place` (the place's name) for a shared place. `label` is a name to show the user (the folder's name for a picked folder). `mode` is `writable`, `read_only` (a folder picked without `mode: 'readwrite'`), or `unavailable`; when it is `unavailable`, `reason` says why (`the folder does not exist`) and `exists` is `false`.

Find a picked folder's root by the handle's name:

```js
const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
const picked = (await fs.roots()).find((root) => root.source === 'granted' && root.label === handle.name)
await fs.writeFile(picked.id, 'export.txt', 'hello')
```

**Keep working data in `private`.** It needs no approval and no picker, it is always writable, and it is not a root of any other app. Use a shared place or a picked folder only for files the user should find outside the app. On disk the private folder is `$XDG_DATA_HOME/acde/files/<app id>/`, which is handy when debugging; the app itself only knows it as `private`.

### Shared places

```jsonc
{ "capabilities": { "fs": { "roots": ["downloads", "documents"] } } }
```

`fs.roots` lists shared places by name: `desktop`, `documents`, `downloads`, `music`, `pictures`, `videos`. Anything else fails `acde check`: `fs.roots "work" is not a shared place (desktop, documents, downloads, music, pictures, videos); any other folder is one the user picks (showDirectoryPicker() with "fs": true)`, and for a path, `fs.roots "~/Documents" is not a shared place: write "documents", the runtime finds that folder through the system (also when it was moved)`. `private` and picked folders come with every `fs` value and are not listed.

Each named place is a capability of its own, `fs.<place>` (`fs.downloads`), and the user must approve it:

- The user is asked before the app's first launch, one place at a time. Until every prompt is answered, **the app opens no window**; `acde dev` prints a line like `Notes (notes) waits for the user to allow "fs.downloads" …`. In a dev session, answer with `acde allow` or `acde deny`; see [Debugging](tools.md#approvals).
- If the user denies a place, the app does not start (`Notes: "fs.documents" is denied by the user`). A single-app `acde dev` then exits, and asks again the next time it is started; in a desktop the denial is kept until it is taken back. See [Capabilities](capabilities.md#approval).
- Once approved, the place is in `roots()` as `{ id: 'downloads', source: 'place', place: 'downloads', … }` and its `id` works as the first argument: `fs.list('downloads')`. When the folder does not exist on this machine, the root has `mode: 'unavailable'` and calls on it reject with `ENOENT`.
- If the user takes the approval back while the app runs, the place leaves `roots()` and calls on it reject with `denied` (see [Errors](#errors)).

To start without asking and ask only when the user needs the place, make `fs` optional. The app then gets `acde:fs` through `load()`, with `private` and picked folders working at once, and asks for a place with `request()`:

```jsonc
{ "capabilities": { "fs": { "roots": ["downloads"] } }, "optional": ["fs"] }
```

```js
import { load } from '@dopame/acde-api'
import { capabilities } from 'acde:capabilities'

const fs = await load('fs')

const status = await capabilities.request('fs.downloads') // asks the user
if (status.state === 'available') {
  const { entries } = await fs.list('downloads')
}
```

See [Capabilities](capabilities.md#approval) for the approval model.

### Paths

The second argument is a **relative path** under the root, separated by `/`; `''` (or leaving it out in `list`) is the root itself. Absolute paths, and escaping the root with `..` or a symbolic link, are rejected.

### Common calls

| Call | Returns |
| --- | --- |
| `roots()` | The roots the app can use now |
| `list(root, path?, hidden?)` | `{root, path, entries, truncated}`; hidden entries are included unless `hidden` is `false` |
| `stat(root, path)` | `{name, kind, size, modifiedMs, path}` (does not follow symbolic links) |
| `readText(root, path)` | `{text, modifiedMs, size}`, up to 64 MiB, `EILSEQ` if not UTF-8 |
| `readBytes(root, path)` | `{data: Uint8Array, modifiedMs, size}` |
| `writeFile(root, path, data, options?)` | Writes text or bytes; returns the entry `{name, kind, size, modifiedMs}` |
| `mkdir(root, path, {recursive?})` | Creates a folder |
| `rename(root, from, to)` | Renames / moves inside one root |
| `delete(root, path)` | Deletes a file or an empty folder: `{status: 'deleted', path}` |
| `copy(fromRoot, fromPath, toRoot, toDir)` | Copies a file or a folder into the folder `toDir` of another root (or the same one); returns the new entry and its `path`. A taken name gets a number (`todo 2.md`) |
| `revoke(id)` | Gives back a folder the user picked |

To bring a file from a shared place or a picked folder into the app's own data, copy it: `await fs.copy('downloads', 'report.txt', 'private', '')`.

### Safe writes

Options for `writeFile`:

- `create`: `'always'` (default, creates the file if missing), `'new'` (`EEXIST` if it already exists), `'never'` (`ENOENT` if it does not exist).
- `ifModifiedMs`: skips the write and fails with `ECONFLICT` if the file's modification time differs from this value. Remember `modifiedMs` when you read and pass it when you write, and you will never overwrite someone else's changes.
- `mkdirs`: creates the parent folders first. Without it, writing into a folder that does not exist fails with `EINVAL`.

Writes go to the original file in place (keeping its inode and permissions) and are fsynced afterwards.

### Errors

On failure the promise rejects with an `Error` that has a `code` and a `status`:

| `code` | `status` | When |
| --- | --- | --- |
| `EINVAL` | 400 | Invalid arguments, an absolute path or one that escapes the root, a missing parent folder, wrong type, symbolic link |
| `EACCES` | 403 | The first argument is not one of the app's roots, the root is read-only, or the system does not allow it |
| `denied` | 403 | The root is a shared place the user has not approved (not asked yet, denied, or taken back); the error also has `capability` (`fs.downloads`) |
| `ENOENT` | 404 | Does not exist |
| `EEXIST` | 409 | Already exists |
| `ECONFLICT` | 409 | Changed or deleted by someone else after it was opened |
| `ENOTEMPTY` | 409 | Deleting a non-empty folder |
| `EFBIG` | 413 | Exceeds the size limit |
| `EILSEQ` | 400 | `readText` read something that is not UTF-8 |
| `ENOSPC` | 507 | Disk full |
| `EIO` | 500 | Anything else |

```js
try {
  await fs.writeFile(root, path, text, { ifModifiedMs })
} catch (e) {
  if (e.code === 'ECONFLICT') askToReload()
  else throw e
}
```

What the common mistakes look like:

| Mistake | Rejection |
| --- | --- |
| A path as the root: `fs.list('/tmp')` | `EACCES`: `this app may not use the files of /tmp (not one of its roots)` |
| A place that is not in `fs.roots`: `fs.list('downloads')` with `"fs": true` | `EACCES`: `this app may not use the files of downloads (not one of its roots)` |
| A place that is in `fs.roots` but not approved | `denied`: `Notes: "fs.downloads" is denied by the user` |
| An absolute path as the second argument: `fs.readText('private', '/etc/hosts')` | `EINVAL`: `path must be relative to the workspace` |
| `..` out of the root: `fs.readText('private', '../x')` | `EINVAL`: `path escapes the workspace` |
| Writing into a folder that does not exist, without `mkdirs` | `EINVAL`: `parent directory is missing or outside the workspace` |
| Writing to a folder picked without `mode: 'readwrite'` | `EACCES`: `<folder> was picked read-only` |
| `fs.locate(path)` or `fs.openPath(root, path)` (they turn paths into roots and back) | `EACCES`: `fs.locate() works only in system apps that declare shared places` |

## Dropped files

When files or folders are dragged from the host system into a window, the page receives the standard drag events, ending in `drop`, and `dataTransfer` carries the files the standard way. The page gets no path.

- Each dropped file or folder is an item of `dataTransfer.items` with `kind: 'file'`; `item.getAsFileSystemHandle()` resolves to a **read-only** `FileSystemFileHandle` or `FileSystemDirectoryHandle` (`createWritable()` rejects with `NotAllowedError`).
- Files up to 64 MiB are also in `dataTransfer.files`. Folders and larger files are not; use their handles.
- `dataTransfer.types` is `['Files']`; there is no `text/uri-list` or `text/plain` with the paths.

To keep a dropped file, copy its content into `private`:

```js
import { fs } from 'acde:fs'

addEventListener('dragover', (event) => event.preventDefault())
addEventListener('drop', async (event) => {
  event.preventDefault()
  const items = [...event.dataTransfer.items].filter((item) => item.kind === 'file')
  const handles = await Promise.all(items.map((item) => item.getAsFileSystemHandle()))
  for (const handle of handles) {
    if (handle.kind !== 'file') continue
    const file = await handle.getFile()
    await fs.writeFile('private', `inbox/${file.name}`, new Uint8Array(await file.arrayBuffer()), { mkdirs: true })
  }
})
```

A handle (from a drop, a picker, or an open request) can also be handed to another app; see [Opening apps](open.md#files-and-links).
