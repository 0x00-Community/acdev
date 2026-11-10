# Files and folders

There are three ways to read and write the user's files:

1. **Standard file pickers**: `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, `<input type="file">`. No capability needed; you get whatever the user picks.
2. **`acde:fs`**: access the user's folders by "root". Suited to apps like file managers and editors. Requires the `fs` capability.
3. **Private storage**: `navigator.storage.getDirectory()` (OPFS), IndexedDB, `localStorage`, for the app's own data.

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
- A folder picked with `showDirectoryPicker({ mode: 'readwrite' })` is **granted to the app**: it then shows up as a root in `acde:fs` (`source: 'granted'`) and is still there on the next launch. Take it back with `fs.revoke(path)`. The default read-only pick only gives this page a read-only handle.
- When the user cancels, the promise rejects with `AbortError`.

## acde:fs

```jsonc
{ "capabilities": { "fs": true } }
```

```js
import { fs } from 'acde:fs'

const roots = await fs.roots()
const desktop = roots.find((r) => r.source === 'desktop')

const { entries } = await fs.list(desktop.path, 'notes')
const { text, modifiedMs } = await fs.readText(desktop.path, 'notes/todo.md')
await fs.writeFile(desktop.path, 'notes/todo.md', text + '\n- a new item', { ifModifiedMs: modifiedMs })
```

### Roots and paths

The first argument of every call is a **root** (the `path` of an item returned by `roots()`), and the second is a **relative path** under that root, separated by `/`. Absolute paths, and escaping the root with `..` or a symbolic link, are rejected.

The roots are:

| `source` | What it is |
| --- | --- |
| `desktop` | The Desktop folder |
| `downloads` | Downloads (when it exists) |
| `default` / `task` | Working folders provided by the system |
| `granted` | Folders the user granted to this app through `showDirectoryPicker({mode: 'readwrite'})` |

`mode` is `writable`, `read_only` or `unavailable` (for example, when a granted folder has been deleted).

To grant only some roots: `"fs": { "roots": [ … ] }`.

### Common calls

| Call | Returns |
| --- | --- |
| `roots()` | All roots |
| `list(root, path?, hidden?)` | `{entries, truncated}` |
| `stat(root, path)` | `{name, kind, size, modifiedMs, path}` (does not follow symbolic links) |
| `readText(root, path)` | `{text, modifiedMs, size}`, up to 64 MiB, `EILSEQ` if not UTF-8 |
| `readBytes(root, path)` | `{data: Uint8Array, modifiedMs, size}` |
| `writeFile(root, path, data, options?)` | Writes text or bytes |
| `mkdir(root, path, {recursive?})` | Creates a folder |
| `rename(root, from, to)` | Renames / moves |
| `delete(root, path)` | Deletes |
| `copyIn(root, dir, source)` | Copies a file from outside into a root (for example, a file dragged into the window) |
| `locate(absolutePath)` | Absolute path → `{root, path}` |
| `revoke(rootPath)` | Revokes a granted folder |

### Safe writes

Options for `writeFile`:

- `create`: `'always'` (default, creates the file if missing), `'new'` (`EEXIST` if it already exists), `'never'` (`ENOENT` if it does not exist).
- `ifModifiedMs`: skips the write and fails with `ECONFLICT` if the file's modification time differs from this value. Remember `modifiedMs` when you read and pass it when you write, and you will never overwrite someone else's changes.
- `mkdirs`: creates the parent folders first.

Writes go to the original file in place (keeping its inode and permissions) and are fsynced afterwards.

### Errors

On failure the promise rejects with an `Error` that has a `code` and a `status`:

| `code` | `status` | When |
| --- | --- | --- |
| `EINVAL` | 400 | Invalid arguments, escaping the root, wrong type, symbolic link |
| `EACCES` | 403 | No permission for this root, or the system does not allow it |
| `EPERM` | 403 | The `copyIn` source is neither in an available root nor a dropped file |
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

## Dropped files

When a file is dragged from the host system into a window, the page receives the standard `dragenter` / `drop` events (`text/uri-list` and `text/plain`). At the same time the system records a one-time grant for the app: for 5 minutes, it can copy the file into a root with `fs.copyIn(root, dir, droppedPath)`.
