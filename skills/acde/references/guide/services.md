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

Register it in the desktop's config:

```jsonc
{ "type": "desktop", "services": { "clock": "services/clock.ts" } }
```

## Call it

The desktop imports it directly; an app must list the **service name** in its `services`:

```jsonc
{ "services": ["clock"] }
```

```js
import { clock } from 'acde:clock'

console.log(await clock.now())
```

A service an app lists is required, and cannot be made optional: where the service is not running the app does not start (`Notes needs "clock" (service not running)`). That includes `acde dev` of the app project alone, which runs no desktop; run the app in the desktop that has the service: `acde dev ./my-app --desktop ./my-desktop`. Listing a service under `capabilities` instead is an error in `acde check` (`capability "clock" is not a system capability; list desktop services under services`).

Each key of `api` is a module name (a namespace), and its value is a set of methods. All calls are asynchronous, and arguments and return values must be structured-cloneable; callback functions can be passed across.

Names:

- Give the service one namespace with the service's own name. The runtime gives an app that lists `clock` every namespace of that service, but `acde check` and `acde build` cannot know a service's namespaces: they judge an `import … from 'acde:timer'` in an app by the names in its `services`, and stop with `acde:timer is a desktop service: list "timer" in the services of Notes` when `timer` is a second namespace of `clock`. Do not follow that hint in this case: listing `timer` makes the app require a service of that name, and it no longer starts (`Notes needs "timer" (service not running)`). Make `timer` a service of its own instead.
- A service cannot have the name of a system module or capability (`fs`, `open`, `window`, `windows`, `apps`, `launch`, `desktop`, `session`, `capabilities`, `notifications`, ...): `acde check` says `service "fs" has the name of a system module (acde:fs); system module names are reserved`. A namespace with such a name is left out when the service starts, with a log line (`[clock] acde.fs is taken; left out`).

## ServiceContext

The `ctx` passed to the factory function:

| Field | What it is |
| --- | --- |
| `name` | The service name |
| `package` | The desktop package's directory |
| `state` | This service's own state directory (`$XDG_STATE_HOME/acde/<package>/<service>`), already created |
| `env` | Environment variables |
| `log(line)` | Writes a log line, prefixed with `[<service name>]` |
| `spawn(argv, options?)` | Starts a child process |
| `inspect` | The `acde:inspect` interface |
| `import(specifier)` | A shell module that a handwritten package manifest grants this service; see below |

`spawn` takes the options `{cwd, env, onLine(line), onExit(code, signal)}` and returns `{pid, write(text), end(), kill(signal?)}`. The child process runs in its own process group and its stderr goes to the log; when the service closes, it gets SIGTERM, then SIGKILL 3 seconds later.

A service should only use `ServiceContext` and standard Web APIs. Put heavy work in a process started with `spawn`.

## Shell modules in a service

A service of a project built from `acde.config.jsonc` gets no shell module except `ctx.inspect`. The config has no field that grants one (its `services` maps names to modules only), so in such a service `ctx.import('acde:windows')` rejects with `acde:windows is a shell module: list it in the modules of service "clock" in the desktop manifest`.

A service does not `import` `acde:` modules either: the build rejects it (`service clock: services/clock.ts imports acde:windows: a service gets shell modules from ctx.import('acde:<name>'), listed in its modules in the desktop manifest (acde.config.jsonc has no field for that list: only a handwritten package manifest grants them)`).

Only a handwritten package can grant shell modules: the desktop's entry in its [manifest](../reference/manifest.md#desktopmanifest) lists the service as `{ "name": "clock", "modules": ["windows"] }` in the desktop's `services`. The service then asks its context:

```js
const { windows } = await ctx.import('acde:windows')
```
