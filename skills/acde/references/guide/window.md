# Windows

Each app window is a separate web page with its own DOM and JS heap; one window crashing does not affect the others. All windows of the same app share storage such as `localStorage`, IndexedDB, and cookies.

## Size and title bar

- A new window's content area is the configured `size` (800 × 600 by default) and opens centered; next time it opens where it was last closed.
- The title bar drawn by the system is **not part of the page's document**: `innerHeight`, `100vh`, and `resize` events only cover the content area. To drop the title bar, set `"frame": false` in the config, draw your own, and use `setGrabHint` to tell the system where the window can be dragged.
- The title comes from `document.title` or `window.setTitle()`; if neither is set, `label` is used.

## acde:window

```js
import { window as self } from 'acde:window'

self.setTitle('Untitled — Notes')

self.on('beforeclose', async () => {
  if (!dirty) return true
  return confirmDiscard() // return false to keep the window open
})
```

> The module is named `window`, the same as the global `window`, so renaming it on import keeps things clear.

| Method | Does |
| --- | --- |
| `setTitle(title)` | Sets the title |
| `setMenus(menus)` | App menus (shown in the desktop's menu bar) |
| `close()` / `minimize()` | Close / minimize |
| `requestAttention()` | Requests attention (for example a bouncing Dock icon; up to the desktop) |
| `requestMode(mode)` | `free` (resizable), `fixed` (move only), `fullscreen`, `pinned` |
| `requestActivate()` | Brings the window to the front and requests focus |
| `setGrabHint(rect, edges?)` | Pressing in this area makes the system move the window (no `edges`) or resize it (with edges) |
| `setBackdrop(rect, effect?)` | Frosted glass over whatever is behind this area: `{radius, blur, saturate, brightness}`; `null` removes it |
| `requestGrab(kind)` / `releaseGrab(kind)` | Takes exclusive pointer or keyboard input (`'pointer'` / `'keyboard'`) |
| `shortcut(combo)` / `unshortcut(combo)` | Registers an app-level global shortcut, such as `'ctrl+shift+k'` |

### Events

Subscribe with `on(name, handler)`, which returns an unsubscribe function. Events are not dispatched on the global `window`.

| Event | When |
| --- | --- |
| `activate` / `deactivate` | The window gains / loses focus |
| `beforeclose` | The user wants to close the window. Return `false` (or resolve to `false`) to keep it; if there is no answer within 3 seconds, it closes |
| `request` | Another app or the system asks this window to open something (see [Opening apps](open.md)) |
| `shortcut` | A registered shortcut was pressed, `{key}` |
| `grab` / `grablost` | Exclusive input was granted / taken back |
| `suspend` / `resume` | The window is suspended / resumed; whatever the `suspend` handler returns is handed back on `resume` |

### Menus

```js
self.setMenus([
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New', shortcut: 'ctrl+n', onSelect: () => newDoc() },
      { type: 'separator' },
      { id: 'close', label: 'Close', onSelect: () => self.close() },
    ],
  },
])
```

## Browser APIs

| API | In acde |
| --- | --- |
| `window.close()` | Closes this window |
| `location.reload()` | Reloads this window |
| `alert()` | Drawn inside the window; `confirm()` / `prompt()` return `false` / `null` |
| External links | Handed to the browser app |
| Downloads | Saved to the Downloads folder |
| `Notification` | Shown by the desktop (a system notification when there is no desktop) |
| `visibilitychange` | The window is hidden / shown |
| `screen.*` | The screen's logical size |

## Module entry

`entry` can also be a module whose default export is a `WindowApp`:

```ts
import type { WindowApp } from '@dopame/acde-api'

const app: WindowApp = {
  mount(element, host) {
    host.setTitle('Hello')
    element.textContent = 'Hello from a module'
    return () => { element.textContent = '' } // unmount
  },
}
export default app
```

## Memory and hangs

- Each window's JS heap has a limit (`heapMb`, 256 MB by default). Exceeding it ends only that window.
- When a single task runs longer than 5 seconds, the desktop is told the window is "not responding" and can end it.
