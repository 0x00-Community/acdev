# Desktops

The Dopame OS desktop is itself an acde project: a web page that fills the screen behind every window. A desktop can import every `acde:` module this platform has except `acde:window` (which is for app windows), including the shell modules that apps do not get, and is responsible for the "system UI": the Dock, the menu bar, window switching, notifications, camera and microphone prompts, and so on. The desktop that ships with Dopame is called `dopame`; you can build your own.

```sh
acde new my-desktop --template desktop
cd my-desktop
acde dev
```

## Configuration

```jsonc
{
  "$schema": "./acde.config.schema.json",
  "type": "desktop",
  "id": "my-desktop",
  "label": "My Desktop",
  "entry": "index.html",
  "services": { "clock": "services/clock.ts" },
  "apps": [
    { "id": "hello", "label": "Hello", "icon": "app", "entry": "apps/hello/index.html" }
  ]
}
```

- `services`: [desktop services](services.md) running in the background, name → module.
- `apps`: apps that ship with this desktop, with the same fields as an app project (`id` and `entry` are required). They are [system apps](#system-apps).

For editor types in a desktop project, reference the shell entry point of the SDK: `/// <reference types="@dopame/acde-api/shell" />`.

## Apps

```js
import { apps } from 'acde:apps'

for (const app of await apps.list()) {
  const button = document.createElement('button')
  button.textContent = app.label
  button.onclick = () => apps.open(app.id)
  dock.append(button)
}

apps.on('changed', ({ apps }) => render(apps))
```

`app.icon` is an icon name or an image URL; the desktop decides how to draw it. An app that cannot run here is not in the list: one that requires a capability this platform lacks. `changed` fires with the new list when it changes.

`apps.open(id)` rejects when the app cannot start: with `status: 404`, `code: 'unsupported_app'` for an app that requires what this platform lacks (`Viewer needs "network" (not available on macOS host windows); list it in "optional" to run without it`), and with `status: 503`, `code: 'service_not_running'` for one whose service is not running (`Viewer needs "clock" (service not running)`). In 0.0.9, an app whose required camera or microphone the user denied also rejects, with `status: 403`, `code: 'denied'` (`Viewer: "camera" is denied by the user`); after 0.0.9 it starts. The desktop also imports `acde:openPath`, `acde:handlers`, and `acde:setDefault` (see [Opening apps](open.md#files-and-links)). Installing packages and listing native programs are in `acde:packages` (`refresh`, `install`, `natives`, `runNative`).

## Windows

```js
import { windows } from 'acde:windows'

windows.on('open', (e) => addToTaskbar(e.window))
windows.on('close', (e) => removeFromTaskbar(e.window))
windows.on('state', (e) => markMinimized(e.window, e.state === 'minimized'))

await windows.focus(id)
await windows.requestState(id, 'minimized')
await windows.animate(id, { opacity: 0, scale: 0.9, duration: 180, easing: 'ease-out' })
```

Window events: `open` `close` `title` `state` `activate` `minsize` `parent` `menus` `crash` `hang` `responsive` `attention` `ready` `show` `animated`. Any other name throws a `TypeError`. Each event is `{type: 'window<name>', window, …}`.

A window's state is `normal`, `minimized`, `filled`, or `fullscreen`. The runtime carries out state changes itself, whether the app asked (`minimize()`, `requestState()`), the user pressed a title bar button, or the desktop called `windows.requestState(id, state)`; the desktop learns of every change from the `state` event (`{window, state, previous}`). `windows.list()` gives every window with its current `state`. `windows.focus(id)` or `windows.show(id)` on a minimized window brings it back in the state it had before. Hiding (`hide` / `show`) is separate from the state and only the desktop can do it. A window that hangs (`hang`) can be ended with `kill`; `close(id)` asks the app first (its `beforeclose`).

## Panels

For things that must float **above** app windows, such as the Dock, the menu bar, and popovers, use `pin` to turn an element of the desktop page into its own always-on-top window:

```js
import { desktop } from 'acde:desktop'

const panel = desktop.pin(document.querySelector('#dock'), { margin: 8, reserve: { edge: 'bottom' } })
// The system re-measures automatically when the element changes; you can also do it by hand:
panel.update()
panel.reserve({ edge: 'bottom', thickness: 64 }) // or null to reserve nothing
panel.unpin()
```

The element stays in the same document, so its state, React tree, and events work as usual. The element must be a stacking context (for example, `position` plus `z-index`, or `isolation: isolate`); its `backdrop-filter` becomes real frosted glass across windows.

`reserve` keeps a strip along one edge of the screen (`top`, `bottom`, `left`, `right`) free of filled windows: the work area shrinks by it, `filled` windows follow, and apps see the new `workArea` in `acde:window`'s `output`. Without `thickness` the strip reaches from the edge to the far side of the panel. A panel without `reserve` takes no space.

## Title bars

The runtime draws the title bar of every app window; the desktop sets how it looks and behaves:

```js
desktop.setDoubleClick('fill') // double-clicking a title bar: 'fill' | 'minimize' | 'none'
desktop.setFrameTheme({
  active: { background: '#202030', title: '#ffffff' },
  inactive: { background: '#2a2a35', title: '#a0a0b0' },
  buttonStyle: 'glyphs', // or 'dots'
  buttonSide: 'right', // or 'left'
  titleAlign: 'start', // or 'center'
})
desktop.setFrameTheme(null) // back to the default look
```

Colors are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`; each of `active` and `inactive` takes `background`, `title`, `line`, and `buttons`. Add `light: { active, inactive }` for the windows whose page does not declare dark support (no `dark` in its `color-scheme`, see [Windows](window.md#size-and-title-bar)); `active` and `inactive` are then for pages that do. Every call gives the whole theme. A bad value throws a `TypeError`; an unknown key is ignored, with a warning in the log.

## Notifications, downloads, and shortcuts

```js
desktop.on('notification', (n) => toast(n.title, n.body, n.icon))
desktop.on('download', (d) => showDownload(d.name, d.path))
desktop.on('edge', ({ edge, entered }) => { if (edge === 'top') menuBar.hidden = !entered })

await windows.shortcut('ctrl+alt+t', 'desktop')
desktop.on('shortcut', ({ key }) => { if (key === 'ctrl+alt+t') apps.open('term') })
```

Shortcut scopes: `session` (highest, cannot be overridden) → app-level shortcuts of the focused window → `desktop`. On conflicts, the first registration wins.

`edge` fires when the pointer reaches (`entered: true`) or leaves an edge of the screen (`top`, `right`, `bottom`, `left`), without taking focus: a desktop that hides its menu bar or Dock over a full-screen window shows them again with it.

## Camera and microphone prompts

The camera and the microphone ask the user the first time an app uses them (see [Capabilities](capabilities.md#camera-and-microphone)); no other capability asks. In 0.0.9, one that an app requires is asked for when the app starts, with `reason: 'launch'`; after 0.0.9, `reason` is always `'request'`. The desktop shows these prompts and passes the answers on with `acde:permissions`:

```js
import { permissions } from 'acde:permissions'

const ask = async (prompt) => {
  // prompt: { id, app, label, capability: 'camera' | 'microphone', reason: 'request' }
  const allow = await showPrompt(`Allow ${prompt.label} to use ${prompt.capability}?`)
  await permissions.answer(prompt.id, allow)
}

permissions.on('prompt', ask)
for (const prompt of await permissions.pending()) ask(prompt) // prompts raised before the page subscribed
```

`permissions.list(app?)` returns the stored decisions (`{app, label, capability, decision: 'granted' | 'denied'}`; a folder the user picked for an app is listed as `fs.folder-…` with `folder: {label, exists}`), and `permissions.revoke(app, capability)` takes one back, resolving to `false` when there was none. The `answered` event (`{id, app, capability, allowed}`) reports each answer.

## System apps

The apps in a desktop's `apps` ship in the same package as the desktop, which makes them **system apps**. They differ from other apps in three ways:

- They may declare shell modules as capabilities and import them: `"capabilities": { "windows": true, "permissions": true }`. An app outside a desktop package that declares one fails `acde check` (`acde:windows is a shell module: only apps of a desktop package (system apps) may declare it`).
- The user is not asked about their camera and microphone.
- With shared places in `fs.roots`, their `acde:fs` roots carry the folder's `path`, and `fs.locate()` / `fs.openPath()` work.

A system app imports only what it declares: `import 'acde:session'` without `"session": true` fails with `acde:session is a shell module: declare "session" in the capabilities of <label>`.

## Other modules

- `acde:session`: `logout()`, `reboot()`, `poweroff()`, `setLanguage(tag)`. Only the desktop page and its system apps that declare `"session": true` can use it; an ordinary app cannot.
- `acde:desktops`: `list()`, `choose(id, remember?)` to switch desktops.
- `acde:launch`: `start(argv)` runs a native program, `embed(argv)` embeds one in a window (Dopame OS only).
- `acde:inspect`: turns the screen into a text semantic tree and acts on it by ref (for AI agents). See the [reference](../reference/modules.md#acdeinspect).

## Developing in a desktop

While developing an app, you can also run it inside a desktop:

```sh
acde dev ./my-app --desktop ./my-desktop
acde dev ./my-app --desktop dopame
```

See [acde dev](dev.md).
