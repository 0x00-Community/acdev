# Services

A desktop service is a JS module that starts and stops with the desktop and runs in the background. It exposes its methods as `acde:<namespace>` modules, one for each key of its `api` (usually just one, named after the service), callable by the desktop and by apps that request the service. It is a good home for global state and for logic that talks to external processes (an AI assistant or a sync service, for example).

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

The desktop imports it directly; an app must list the **service name** in its `capabilities`:

```jsonc
{ "capabilities": { "clock": true } }
```

```js
import { clock } from 'acde:clock'

console.log(await clock.now())
```

Each key of `api` is a module name (a namespace), and its value is a set of methods. All calls are asynchronous, and arguments and return values must be structured-cloneable; callback functions can be passed across. Namespaces that clash with built-in modules (`windows`, `apps`, `window`, `open`, `desktop`, `desktops`, `session`, `inspect`) are ignored.

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

`spawn` takes the options `{cwd, env, onLine(line), onExit(code, signal)}` and returns `{pid, write(text), end(), kill(signal?)}`. The child process runs in its own process group and its stderr goes to the log; when the service closes, it gets SIGTERM, then SIGKILL 3 seconds later.

A service should only use `ServiceContext` and standard Web APIs. Put heavy work in a process started with `spawn`.
