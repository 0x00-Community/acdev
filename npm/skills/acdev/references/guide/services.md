# Services

A desktop service is a JS module that starts and stops with the desktop and runs in the background. It exposes its methods as `acde:<namespace>` modules, one for each key of its `api` (usually just one, named after the service), callable by the desktop and by apps that list the service. It is a good home for global state and for logic that talks to external processes (an AI assistant or a sync service, for example).

## Write a service

```ts
// services/clock.ts
import type { ServiceFactory } from '@dopame/acde-api'

const clock: ServiceFactory = (ctx) => {
  ctx.log('clock started')
  return {
    api: {
      clock: {
        now: () => Date.now(),
        async uptime() {
          return new Promise((resolve) => {
            ctx.spawn(['uptime'], { onLine: resolve })
          })
        },
      },
    },
    close() {
      ctx.log('clock stopped')
    },
  }
}
export default clock
```

Register it in the desktop's config, under the service's name:

```jsonc
{ "type": "desktop", "services": { "clock": "services/clock.ts" } }
```

A service that uses shell modules is written as an object that also lists them; see [Shell modules in a service](#shell-modules-in-a-service).

## Call it

The desktop imports it directly; an app must list the **service name** in its `services`:

```jsonc
{ "services": ["clock"] }
```

```js
import { clock } from 'acde:clock'

console.log(await clock.now())
```

A service an app lists is required, and cannot be made optional: where the service is not running the app does not start (`Notes needs "clock" (service not running)`). That includes `acdev dev` of the app project alone, which runs no desktop; run the app in the desktop that has the service: `acdev dev ./my-app --desktop ./my-desktop`. Listing a service under `capabilities` instead is an error in `acdev check` (`capability "clock" is not a system capability; list desktop services under services`).

Each key of `api` is a module name (a namespace), and its value is a set of methods. All calls are asynchronous (except the methods a service lists in `sync`, see [Service API](../reference/service.md)), and arguments and return values must be structured-cloneable; callback functions can be passed across.

Names:

- An app lists the **service's name**, and gets every namespace of that service: with `api: { clock: …, timer: … }` in the service `clock`, an app that lists `clock` imports both `acde:clock` and `acde:timer`. Never list a namespace: an app that lists `timer` requires a service of that name and does not start (`Notes needs "timer" (service not running)`).
- `acdev check` and `acdev build` cannot know a service's namespaces (they are what the factory returns at run time). An import of the service's own name passes silently. An import of any other name that is not a system module passes with a note in an app that lists a service, and the exit code stays 0:

  ```text
  note: src/main.js:1: app "notes": acde:timer resolves only if the service Notes lists ("clock") provides the "timer" namespace
  ```

  If no listed service provides it, the import throws an `AcdeError` (`code: 'forbidden'`, `status: 403`) when the page loads (`'acde:timer' is not given to …`). In an app that lists no service, the same import is an error: `error: src/main.js:1: app "notes": acde:timer is not a system module; if a desktop service provides it, list that service's name in the services of Notes`. A service with one namespace, named after the service, gets no note.
- A service cannot have the name of a system module or capability (`fs`, `open`, `window`, `windows`, `apps`, `launch`, `desktop`, `session`, `capabilities`, `notifications`, ...): `acdev check` says `service "fs" has the name of a system module (acde:fs); system module names are reserved`. A namespace with such a name is left out when the service starts, and the runtime logs a line that ends, word for word, `[clock] acde.fs is taken; left out` (it writes the namespace as `acde.fs`, with a dot).

## ServiceContext

The `ctx` passed to the factory function:

| Field | What it is |
| --- | --- |
| `name` | The service name |
| `package` | The desktop package's directory |
| `state` | This service's own state directory (`$XDG_STATE_HOME/acde/<package name>/<service>`, the desktop package's `name` without `@` and with `/` as `-`), already created |
| `env` | Environment variables |
| `log(line)` | Writes a log line, prefixed with `[<service name>]` |
| `spawn(argv, options?)` | Starts a child process |
| `inspect` | The `acde:inspect` interface |
| `import(specifier)` | A shell module the desktop grants this service; see below |

`spawn` takes the options `{cwd, env, onLine(line), onExit(code, signal)}` and returns `{pid, write(text), end(), kill(signal?)}`. The child process runs in its own process group and its stderr goes to the log; when the service closes, it gets SIGTERM, then SIGKILL 3 seconds later.

A service should only use `ServiceContext` and standard Web APIs. Put heavy work in a process started with `spawn`.

## Shell modules in a service

A service cannot `import` an `acde:` module; the build rejects it:

```text
acdev: service clock: services/clock.ts imports acde:windows: a service gets shell modules from ctx.import('acde:<name>'), listed in its modules in acde.config.jsonc ("services": { "clock": { "module": "<file>", "modules": ["<name>"] } })
```

It asks its context for the shell modules the desktop grants it. Grant them in the desktop's config: write the service as an object with its module file and the shell modules it may use.

```jsonc
{
  "type": "desktop",
  "services": {
    "clock": { "module": "services/clock.ts", "modules": ["windows"] }
  }
}
```

```ts
// services/clock.ts
import type { ServiceFactory } from '@dopame/acde-api'

const clock: ServiceFactory = async (ctx) => {
  const { windows } = await ctx.import('acde:windows')
  windows.on('open', (event) => ctx.log(`window ${event.window} opened`))
  return {
    api: {
      clock: {
        now: () => Date.now(),
        windows: () => windows.list(),
      },
    },
  }
}
export default clock
```

With one app window open, `clock.windows()` answers `[{ "id": 1048576, "appId": "tools", "title": "Tools", "web": true, "state": "normal" }]`.

`modules` takes the names of shell modules. Anything else is an error in `acdev check` and `acdev build`:

```text
error: services in acde.config.jsonc: service "clock": modules lists shell modules (windows, packages, session, desktops, inspect, desktop, setDefault, permissions)
```

`acdev build` writes the grant into the desktop's entry of the package manifest as `{ "name": "clock", "modules": ["windows"] }`; a handwritten package writes that entry itself (see [Manifest](../reference/manifest.md#desktopmanifest)).

What `ctx.import()` gives:

| Module | In a service |
| --- | --- |
| `acde:windows` | The whole module, as the desktop page has it: `list()`, the events, `requestState()`, and the rest |
| `acde:packages` | The whole module, with its `changed` event |
| `acde:session`, `acde:desktops`, `acde:inspect`, `acde:setDefault` | The whole module |
| `acde:desktop` | `apps()` only: a service has no page to pin panels from |
| `acde:permissions` | Not given: `acde:permissions is not available to services here` |

`ctx.inspect` needs no grant. `ctx.import()` rejects with a `TypeError` for a shell module the service is not granted (`acde:session is a shell module: list it in the modules of service "clock" in the desktop manifest`) and for anything that is not a shell module (`import(acde:fs): a service imports shell modules (acde:windows, acde:packages, …)`). A factory that lets the rejection through does not start its service; the runtime logs `[clock] not started: TypeError: …`.
