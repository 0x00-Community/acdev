# Desktops

The Dopame OS desktop is itself an acde project: a web page that fills the screen behind every window. A desktop can import every `acde:` module except `acde:window` (which is for app windows), and is responsible for the "system UI": the Dock, the menu bar, window switching, notifications, and so on. The desktop that ships with Dopame is called `dopame`; you can build your own.

```sh
acde new my-desktop --template desktop
cd my-desktop
acde dev
```

## Configuration

```jsonc
{
  "$schema": "./node_modules/@dopame/acde-api/config.schema.json",
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
- `apps`: apps that ship with this desktop, with the same fields as an app project (`id` and `entry` are required).

## Apps

```js
import { apps } from 'acde:apps'

for (const app of await apps.list()) {
  const button = document.createElement('button')
  button.textContent = app.label
  button.onclick = () => apps.launch(app.id)
  dock.append(button)
}

apps.on('changed', ({ apps }) => render(apps))
```

`app.icon` is an icon name or an image URL; the desktop decides how to draw it.

## Windows

```js
import { windows } from 'acde:windows'

windows.on('open', (e) => addToTaskbar(e.window))
windows.on('close', (e) => removeFromTaskbar(e.window))
windows.on('minimize', (e) => windows.hide(e.window))

await windows.focus(id)
await windows.animate(id, { opacity: 0, scale: 0.9, duration: 180, easing: 'ease-out' })
```

Window events: `open` `close` `title` `fullscreen` `unfullscreen` `minimize` `activate` `minsize` `parent` `menus` `crash` `hang` `responsive` `attention` `ready` `show` `animated`.

Only the desktop can hide, show, or raise windows; an app's `minimize()` merely notifies the desktop (the `minimize` event), and the desktop decides what to do. A window that hangs (`hang`) can be ended with `kill`.

## Panels

For things that must float **above** app windows, such as the Dock, the menu bar, and popovers, use `pin` to turn an element of the desktop page into its own always-on-top window:

```js
import { desktop } from 'acde:desktop'

const panel = desktop.pin(document.querySelector('#dock'), { margin: 8 })
// The system re-measures automatically when the element changes; you can also do it by hand:
panel.update()
panel.unpin()
```

The element stays in the same document, so its state, React tree, and events work as usual. The element must be a stacking context (for example, `position` plus `z-index`, or `isolation: isolate`); its `backdrop-filter` becomes real frosted glass across windows.

## Notifications, downloads, and shortcuts

```js
desktop.on('notification', (n) => toast(n.title, n.body, n.icon))
desktop.on('download', (d) => showDownload(d.name, d.path))

await windows.shortcut('ctrl+alt+t', 'desktop')
desktop.on('shortcut', ({ key }) => { if (key === 'ctrl+alt+t') apps.launch('term') })
```

Shortcut scopes: `session` (highest, cannot be overridden) → app-level shortcuts of the focused window → `desktop`. On conflicts, the first registration wins.

## Other modules

- `acde:session`: `logout()`, `reboot()`, `poweroff()`, `setLanguage(tag)`.
- `acde:desktops`: `list()`, `choose(id, remember?)` to switch desktops.
- `acde:inspect`: turns the screen into a text semantic tree and acts on it by ref (for AI agents). See the [reference](../reference/modules.md#acdeinspect).

## Developing in a desktop

While developing an app, you can also run it inside a desktop:

```sh
acde dev ./my-app --desktop ./my-desktop
acde dev ./my-app --desktop dopame
```

See [acde dev](dev.md).
