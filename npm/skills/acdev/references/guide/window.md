# Windows

Each app window is a separate web page with its own DOM and JS heap; one window crashing does not affect the others. All windows of the same app share storage such as `localStorage`, IndexedDB, and cookies.

## Size and title bar

- In a desktop, a new window's content area is the configured `size` (800 × 600 by default) and opens centered; next time it opens where it was last closed.
- In an `acdev dev` session that runs a single app (an app project without `--desktop`), the app **fills the host window**, and `size` sets how large that window opens: with `"size": [400, 300]` the host window's content area is 400 × 300. The title bar is drawn inside it, so the page is 400 × 268. Without `size` the host window takes most of the screen (90% of its width and 85% of its height, at most 1440 × 900).
- `acdev dev --headless` has no host window, and `size` is not applied: the screen is 1440 × 900 (1280 × 800 in `acdev test`) and the app fills it, so the page is 1440 × 868. To see the app in a window of its own `size`, run it in a desktop: `acdev dev --desktop ./my-desktop`, or `--desktop dopame` once that desktop is installed (see [acdev dev](dev.md#what-runs)).
- The title bar drawn by the system is **not part of the page's document**: `innerHeight`, `100vh`, and `resize` events only cover the content area. To drop the title bar, set `"frame": false` in the config, draw your own, and use `setGrabHint` to tell the system where the window can be dragged.
- The title comes from `document.title` or `window.setTitle()`, whichever was set last (a `<title>` in the page replaces a title set before the document loaded); if neither is set, `label` is used.
- Declare the colour schemes your page supports, as in a browser: `color-scheme: light dark` on the root (`:root { color-scheme: light dark }`) or `<meta name="color-scheme" content="light dark">` when it follows the system with `prefers-color-scheme`, `dark` when it is always dark. The system draws a dark title bar only for pages that name `dark`; a page that declares nothing is taken as light only and gets a light title bar even in a dark theme. The `html` template follows the system and declares `light dark`. An app run on its own (an `acdev dev` of the app, `acdev test`) gets a dark title bar while the page is dark: a page that names only `dark` always, a page that names `light dark` while `prefers-color-scheme` is `dark` (the system's scheme, or `emulate({ colorScheme })` in a test). As in browsers, the root's `color-scheme` counts before the meta: an app with its own light / dark switch sets `color-scheme: dark` or `light` on the root, and the title bar follows it.
- The system colours `AccentColor` and `AccentColorText` follow the system accent colour (in a `--session vm` guest the accent chosen in the Settings app, on a Linux host the desktop portal's `accent-color`; Windows and macOS hosts keep the defaults): `AccentColor` is that colour and `AccentColorText` is white or black, whichever reads better on it. With no accent set they keep the browser defaults (`#0075ff` with white text, `#99c8ff` with black in dark). Use them for highlights that should match the system, e.g. `button.primary { background: AccentColor; color: AccentColorText }`. When the accent changes, open pages restyle at once and `getComputedStyle` returns the new colour; no media query covers it. To tell "no accent set" from "the user picked `#0075ff`", or to act on a change, use `acde:window`: `accent()` returns the system value as `#rrggbb`, or `null` when the system sets none (always `null` on Windows and macOS hosts), and `on('accent', (color) => …)` fires with the new value (`null` included) when it changes, e.g. `const brand = self.accent() ?? '#6b4eff'`.
- To keep text readable over the wallpaper (a bar, a clock or a dock drawn on glass), read `wallTone()` from `acde:window`: `'light'` when the wallpaper on the window's screen is bright, so dark text reads on it, `'dark'` when it is dark, `null` while the system has no answer (before the wallpaper is known, or always on Windows, macOS and Linux hosts). `on('wallTone', (tone) => …)` fires when the wallpaper changes or the window moves to a screen with another tone, only when the value changes. The type is `WallTone` from `/api`.

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
| `setMaterial(material, options?)` / `material()` | The window background material, drawn under the page; see [Window material](#window-material) |
| `accent()` / `on('accent')` | The system accent colour as `#rrggbb`, `null` when the system sets none; the event fires with the new value; see [Size and title bar](#size-and-title-bar) |
| `wallTone()` / `on('wallTone')` | Whether the wallpaper under the window is `light` or `dark` (`null` when unknown); the event fires with the new value |
| `requestGrab(kind)` / `releaseGrab(kind)` | Takes exclusive pointer or keyboard input (`'pointer'` / `'keyboard'`) |
| `shortcut(combo)` / `unshortcut(combo)` | Registers an app-level global shortcut, such as `'ctrl+shift+k'` |
| `hostControls` | `true` when the host system draws the window's minimize / maximize / close buttons, so a frameless app should hide its own |
| `minimizable` | `false` when this window cannot be minimized. In a session that runs a single app, on macOS and headless, the app's window is such a window: it fills the host window |

### Window material

The system draws a material under the whole window (or only its title bar) and the page shows through where its background is transparent:

```js
import self from 'acde:window'

self.setMaterial('blur')                                                  // background blur with a tint
self.setMaterial('glass', { role: 'clear' })                              // liquid glass
self.setMaterial('glass', { group: 'com.example.tools', spacing: 10 })     // merges with other windows in the group
self.setMaterial('glass', { overrides: { outline: 'none' } })             // one parameter changed
self.setMaterial('none')
self.material() // { material: 'glass', options: { overrides: { outline: 'none' } } }
```

- Materials: `glass` (liquid glass: blur, lens, highlight and outline; `role` is `regular`, the default, or `clear`, one step clearer), `blur` (background blur with a tint, no lens and no highlight), `none`. Names are open (`[a-z0-9._-]`, at most 64 bytes) so that effects added later can have their own; a name the system does not have draws as `none` and logs one warning, and `material()` then reports `none`.
- Options: `role` and `group` apply to `glass` only. `group` is a session-wide name for the **window layer**: windows of any app that use the same group merge their window glass when they come within `spacing` (logical pixels, default 10). Glass elements inside a page (`--acde-glass` in CSS) are another layer: they never merge with the window's own material, and never with elements in other windows; inside a page, glass that turns merging on merges only with glass at the same level (the nearest glass ancestor), so a button inside a glass toolbar does not merge with the toolbar. `overrides` maps parameter names (as `--acde-glass-*` without the prefix: `blur`, `tint`, `outline`, `highlight`, `lens` ...) to their CSS text. `region` is `window` (default) or `titlebar`.
- How clear materials are (the transparency level) and light or dark come from the user's settings; with reduced transparency every material is opaque. The app picks the material and role, not the numbers.
- A wrong name format, `role`, `region`, `group` or `spacing` throws a `TypeError`.
- The manifest sets the material a window opens with: `"window": { "material": "blur" }` or `{ "name": "glass", "role": "clear" }` (see the manifest reference). In a project that is `acde.config.json`'s `window`.
- Advice: `blur` for the background of a main window that stays open long (medium cost), `glass` for toolbars and small panel windows floating over content (most expensive), `blur` for short-lived popups. The page background must be transparent for the material to show.
- `setBackdrop` (a frosted area in page coordinates) stays as it was; `setMaterial` is the background of the whole window.
- In the single-app host window `glass` and `blur` are drawn by acdev itself; windows there do not merge across a group yet.

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

Subscribe with `on(name, handler)`, which returns an unsubscribe function. A name the module does not have throws a `TypeError` (`acde:window has no nosuch event (activate, deactivate, beforeclose, request, suspend, resume, grab, grablost, state, output, hostcontrols, minimizable, accent, wallTone, shortcut)`). Events are not dispatched on the global `window`.

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
| `accent` | The system accent colour changed; the handler gets the new `#rrggbb`, or `null` when it was unset |
| `wallTone` | The wallpaper under the window turned light or dark (or unknown); the handler gets `'light'`, `'dark'` or `null` |

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
import type { WindowApp } from '@acde/api'

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
