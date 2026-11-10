# Opening apps

## Apps

```jsonc
{ "capabilities": { "open": ["viewer"] } }
```

```js
import { open } from 'acde:open'

const { window } = await open('viewer', { image: '/photos/cat.png' })
```

The second argument is any structured-cloneable object, handed to the other app. Setting the `open` capability to `true` allows any app; a list allows only the apps listed.

The app being opened receives it through the `request` event:

```js
import { window as self } from 'acde:window'

self.on('request', (request) => {
  showImage(request.image)
})
```

For a window opened for a request, the request is delivered once, to the first `request` handler only; a request that arrives before any handler is registered is held and delivered when one is.

## Files

An app declares the types it can open in its config:

```jsonc
{
  "id": "notes",
  "mimeTypes": ["text/markdown", "text/plain"]
}
```

When the user double-clicks a `.md` file in the file manager, or another app calls `openPath`, the system picks an app in this order:

1. The default app the user has set (XDG MIME Applications spec, `mimeapps.list`);
2. The first app whose `mimeTypes` lists the type (an exact type wins over `text/*`);
3. A native program (Dopame OS / Linux only).

The chosen app receives a `request`: apps with the `fs` capability get `{root, path, file}` and can read it directly with `acde:fs`; others get `{url}`.

Apps that request `openFiles` can do this themselves:

```js
import { openPath } from 'acde:openPath'
import { handlers } from 'acde:handlers'
import { setDefault } from 'acde:setDefault'

await openPath('/home/me/Desktop/todo.md')
const { mime, handlers: list } = await handlers('/home/me/Desktop/todo.md')
await setDefault('text/markdown', 'notes')
```

File types are detected with shared-mime-info, so a dev session on macOS gets the same results as Dopame OS (for example, `.md` is `text/markdown`). On macOS this needs `brew install shared-mime-info`; without it, a one-line warning is printed.
