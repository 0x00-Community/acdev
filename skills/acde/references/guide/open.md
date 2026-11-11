# Opening apps

## Apps

```jsonc
{ "capabilities": { "open": ["viewer"] } }
```

```js
import { open } from 'acde:open'

const { window } = await open('viewer', { kind: 'show-image', image: '/photos/cat.png' })
```

The second argument is a **request**: a structured-cloneable object with a `kind`, handed to the other app. `open('viewer')` without a request just opens the app (or brings its window to the front). Setting the `open` capability to `true` allows any app; a list allows only the apps listed.

The app being opened says which kinds of request it accepts in its config, and receives them through the `request` event:

```jsonc
{ "id": "viewer", "requests": ["show-image"] }
```

```js
import { window as self } from 'acde:window'

self.on('request', (request) => {
  if (request.kind === 'show-image') showImage(request.image)
})
```

`requests` lists the app's own request kinds (lowercase words such as `show-image`). The runtime checks only the `kind`; the receiving app checks the rest of the object. An app with no `requests` accepts none.

For a window opened for a request, the request is delivered once, to the first `request` handler only; a request that arrives before any handler is registered is held and delivered when one is. An app that is not `multiple` and already runs gets the request in its existing window.

`open(app, request, { parent, modal })` makes the new window a child of one of your own windows (`parent` is a window id, such as `self.id`), centered over it; `modal: true` keeps input away from the parent until the child closes.

What goes wrong:

| Call | Rejection (`status`, `code`) |
| --- | --- |
| `open('mail')` when `open` does not allow `mail` | 403 `forbidden`: `Notes may not use open mail (not in its manifest's capabilities)` |
| A request without `kind` | 400 `untyped_request`: `a request to viewer needs a kind` |
| A `kind` that is not in the target's `requests` | 409 `not_accepted`: `viewer does not accept other-kind requests (its manifest's requests)` |

To list the installed apps, use `acde:apps`; its `open` is the same function:

```js
import { apps } from 'acde:apps'

const installed = await apps.list() // [{ id, label, icon, script }]
```

## Files and links

An app declares the file types and the link schemes it can open in its config:

```jsonc
{
  "id": "notes",
  "mimeTypes": ["text/markdown", "text/plain"],
  "schemes": ["mailto"]
}
```

When the user double-clicks a `.md` file in the file manager, or another app asks for it to be opened, the system picks an app in this order:

1. The default app the user has set (XDG MIME Applications spec, `mimeapps.list`);
2. The first app whose `mimeTypes` lists the type (an exact type wins over `text/*`);
3. A native program (Dopame OS / Linux), or the system's default program (the host window on macOS and Windows).

The chosen app receives a **system request**. A file arrives as `{ kind: 'open-file', handle }`, where `handle` is a standard `FileSystemFileHandle` (or a directory handle); a link arrives as `{ kind: 'open-link', url }`. The app gets no path:

```js
self.on('request', async (request) => {
  if (request.kind === 'open-file') showText(await (await request.handle.getFile()).text())
  if (request.kind === 'open-link') compose(request.url)
})
```

Apps that request `openFiles` can hand a file or a link to its default app themselves. Leave out the app id and the system picks:

```js
import { open } from 'acde:open'

await open({ kind: 'open-file', handle }) // a handle from a picker, a drop, or a request
await open({ kind: 'open-link', url: 'mailto:someone@example.com' })
```

With an app id (`open('viewer', { kind: 'open-file', handle })`) the request goes to that app; this needs `open` rather than `openFiles`, and is rejected with 409 `not_accepted` when the target does not declare the file's type in `mimeTypes` or the link's scheme in `schemes`. A read-only handle (from a drop) stays read-only for the receiver.

`acde:openPath` and `acde:handlers` (also `openFiles`) work with a path or a URI instead of a handle:

```js
import { openPath } from 'acde:openPath'
import { handlers } from 'acde:handlers'

await openPath('/home/me/Notes/todo.md')
const { mime, association, handlers: list } = await handlers('/home/me/Notes/todo.md')
```

They suit the desktop and system apps, which know paths. For an ordinary app the file must be inside one of its `acde:fs` roots, or the call is rejected with 404 `outside_roots`; an app that holds handles uses `open({ kind: 'open-file', handle })`.

Changing the default app for a type is `setDefault(association, app)` from `acde:setDefault`, a shell module for the desktop and system apps (`association` is the value `handlers()` returned).

File types are detected with shared-mime-info, so a dev session on macOS gets the same results as Dopame OS (for example, `.md` is `text/markdown`). On macOS this needs `brew install shared-mime-info`; without it, a one-line warning is printed.
