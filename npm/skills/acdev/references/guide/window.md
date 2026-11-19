# Windows

Each app window is a separate web page with its own DOM and JS heap; one window crashing does not affect the others. All windows of the same app share storage such as `localStorage`, IndexedDB, and cookies.

## Size and title bar

- In a desktop, a new window's content area is the configured `size` (800 × 600 by default) and opens centered; next time it opens where it was last closed.
- In an `acdev dev` session that runs a single app (an app project without `--desktop`), the app **fills the host window**, and `size` sets how large that window opens: with `"size": [400, 300]` the host window's content area is 400 × 300. The title bar is drawn inside it, so the page is 400 × 268. Without `size` the host window takes most of the screen (90% of its width and 85% of its height, at most 1440 × 900).
- `acdev dev --headless` has no host window, and `size` is not applied: the screen is 1440 × 900 (1280 × 800 in `acdev test`) and the app fills it, so the page is 1440 × 868. To see the app in a window of its own `size`, run it in a desktop: `acdev dev --desktop ./my-desktop`, or `--desktop dopame` once that desktop is installed (see [acdev dev](dev.md#what-runs)).
- The title bar drawn by the system is **not part of the page's document**: `innerHeight`, `100vh`, and `resize` events only cover the content area. To drop the title bar, set `"frame": false` in the config, draw your own, and use `setGrabHint` to tell the system where the window can be dragged.
- The title comes from `document.title` or `window.setTitle()`, whichever was set last (a `<title>` in the page replaces a title set before the document loaded); if neither is set, `label` is used.
- Declare the colour schemes your page supports, as in a browser: `color-scheme: light dark` on the root (`:root { color-scheme: light dark }`) or `<meta name="color-scheme" content="light dark">` when it follows the system with `prefers-color-scheme`, `dark` when it is always dark. The system draws a dark title bar only for pages that name `dark`; a page that declares nothing is taken as light only and gets a light title bar even in a dark theme. The `html` template follows the system and declares `light dark`. An app run on its own (an `acdev dev` of the app, `acdev test`) gets a dark title bar while the page is dark: a page that names only `dark` always, a page that names `light dark` while `prefers-color-scheme` is `dark` (the system's scheme, or `emulate({ colorScheme })` in a test). As in browsers, the root's `color-scheme` counts before the meta: an app with its own light / dark switch sets `color-scheme: dark` or `light` on the root, and the title bar follows it.

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

| Member | Does |
| --- | --- |
| `id` | This window's id (a number) |
| `setTitle(title)` | Sets the title |
| `setMenus(menus)` | App menus (shown in the desktop's menu bar) |
| `close()` | Closes the window at once; `beforeclose` is not asked |
| `minimize()` | Minimizes the window, as `requestState('minimized')` does; the promise rejects with `status: 409`, `code: 'unavailable'` when the window cannot be minimized |
| `state` / `requestState(state)` | The window's state: `normal`, `minimized`, `filled` (fills the work area), `fullscreen`; see [Window state](#window-state) |
| `requestMode(mode)` | Whether the user can move and resize the window: `free` (both), `fixed` (move only), `pinned` (neither) |
| `output` | The screen the window is on: `{width, height, scale, workArea: {x, y, width, height}}` in logical pixels; `workArea` leaves out what the desktop's panels reserve. In a session that runs a single app the screen is the host window: with `"size": [400, 300]`, `output` and its `workArea` are both 400 × 300 |
| `requestAttention()` | Requests attention (for example a bouncing Dock icon; up to the desktop) |
| `requestActivate()` | Brings the window to the front and requests focus; the system may turn this into a request for attention |
| `setGrabHint(rect, edges?)` | Pressing in this area makes the system move the window (no `edges`) or resize it (with edges) |
| `setBackdrop(rect, effect?)` | Frosted glass over whatever is behind this area: `{radius, blur, saturate, brightness}`; `null` removes it |
| `requestGrab(kind)` / `releaseGrab(kind)` | Takes exclusive pointer or keyboard input (`'pointer'` / `'keyboard'`) |
| `shortcut(combo)` / `unshortcut(combo)` | Registers an app-level global shortcut, such as `'ctrl+shift+k'` |
| `hostControls` | `true` when the host system draws the window's minimize / maximize / close buttons, so a frameless app should hide its own |
| `minimizable` | `false` when this window cannot be minimized. In a session that runs a single app, on macOS and headless, the app's window is such a window: it fills the host window |

### Window state

Full screen is a **state** of the window, not a mode: `requestMode('fullscreen')` throws a `TypeError` (`requestMode: full screen is a window state, use requestState('fullscreen')`).

```js
self.on('state', ({ state, previous }) => {
  document.body.dataset.windowState = state
})

self.requestState('fullscreen') // 'normal' | 'minimized' | 'filled' | 'fullscreen'
```

- `requestState()` returns nothing. The system decides: when it refuses, nothing changes and no event arrives. A `fixed` window can only be minimized, and a `pinned` one cannot change state. A window whose `minimizable` is `false` cannot be minimized: `requestState('minimized')` changes nothing, and `minimize()` rejects.
- The state also changes without the page asking: the title bar's buttons, the desktop minimizing the window, the user bringing a minimized window back. Keep the UI in step with the `state` event (or `self.state`), not with what the page last requested.
- A minimized window that gets the focus again returns to the state it had before (`fullscreen`, for example).
- In a single-app `acdev dev` session the app already fills the host window, and state requests may change nothing (headless on macOS, `minimized`, `filled` and `fullscreen` all leave the state `normal`, and no event arrives). Try states in a desktop session.
- The standard Fullscreen API (`element.requestFullscreen()`) is not supported; it rejects with `NotSupportedError`.

### Events

Subscribe with `on(name, handler)`, which returns an unsubscribe function. A name the module does not have throws a `TypeError` (`acde:window has no nosuch event (activate, deactivate, beforeclose, request, suspend, resume, grab, grablost, state, output, hostcontrols, minimizable, shortcut)`). Events are not dispatched on the global `window`.

| Event | When |
| --- | --- |
| `activate` / `deactivate` | The window gains / loses focus |
| `state` | The window's state changed, `{state, previous}` |
| `output` | The screen or its work area changed; the handler gets the new `output` |
| `beforeclose` | The user or the desktop wants to close the window. Return `false` (or resolve to `false`) to keep it; if there is no answer within 3 seconds, it closes |
| `request` | Another app or the system asks this window to open something (see [Opening apps](open.md)) |
| `shortcut` | A registered shortcut was pressed, `{key}` |
| `grab` / `grablost` | Exclusive input was answered, `{kind, granted}` / taken back, `{kind: 'lost', reason}` |
| `hostcontrols` / `minimizable` | `hostControls` / `minimizable` changed; the handler gets the new value |

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

Call `setMenus` again with the whole list to change anything (a `checked` mark, a `disabled` item). Where the menus show:

- In a desktop, in its menu bar (the Dopame desktop shows the focused window's menus).
- An app run on its own (an `acdev dev` of the app, `acdev test`) shows them on the title bar the system draws: the menu names after the window buttons, the window's title moved past them. A name opens its menu on a press; the arrow keys, Return and Escape work the open menu, and choosing an item runs its `onSelect`. An item without `onSelect` is shown disabled. `acdev inspect` lists the menus first (`menuitem "File" [collapsed] [w1.m1]`, and the items of the open one, `w1.m1.2`), `acdev act w1.m1.2 click` opens the menu and chooses the item, and in a test `getByRole('menuitem', { name: 'New' })` finds them. With `"frame": false` there is no title bar, so no menus either.

An item's `shortcut` (`'ctrl+n'`, the same names as `shortcut()`, also `mod`, which is ⌘ on macOS and Ctrl elsewhere) is shown next to it. In a desktop it is only shown: to have the key work, register the combo with `self.shortcut()` as well and handle the `shortcut` event. An app run on its own has it bound too, while its window is focused: pressing it runs the item's `onSelect`, as long as the item has one and is not `disabled`. The page then gets no `keydown` for that combo (an `Edit` item with `ctrl+c` takes copy from text fields as well), and if the app also registered it with `self.shortcut()`, the item runs and no `shortcut` event comes, so it does not run twice.

## A second window of your app

An app opens another window of itself with `open` from `acde:open`, like any other app. It needs two things in its config: `multiple`, so that a second window is allowed, and its own id in the `open` capability:

```jsonc
{
  "id": "notes",
  "multiple": true,
  "requests": ["edit-note"],
  "capabilities": { "open": ["notes"] }
}
```

```js
import { open } from 'acde:open'
import { window as self } from 'acde:window'

const { window } = await open('notes', { kind: 'edit-note', note: 'todo' })

self.on('request', (request) => {
  if (request.kind === 'edit-note') load(request.note)
})
```

- The new window runs the same `entry`; a request tells it what to show. Like any request it needs a `kind` that the app lists in its own `requests`; `open('notes')` with no request opens a plain window.
- Without `multiple`, `open('notes', …)` opens nothing new: it resolves with the window that already runs, and that window gets the request.
- Without `notes` in `open`, the call is rejected with 403 `forbidden` (`Notes may not use open notes (not in its manifest's capabilities)`), even though it is the app's own id.
- Pass `{ parent: self.id }` as the third argument to make the new window a child of this one (see [Opening apps](open.md#apps)).
- The windows share storage (`localStorage`, IndexedDB, cookies) but not memory: each is its own page.

## Browser APIs

| API | In acdev |
| --- | --- |
| `window.close()` | Closes this window |
| `location.reload()` | Reloads this window |
| `alert()` | Drawn inside the window; `confirm()` / `prompt()` return `false` / `null` |
| External links | Handed to the browser app |
| Downloads | Saved to the Downloads folder |
| `Notification` | Shown by the desktop (a system notification when there is no desktop, except on Windows, where a single app shows none; `acde:capabilities` reports `notifications` `unsupported` there) |
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
