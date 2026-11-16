# First app

## Create

```sh
acde new my-app
```

In a terminal, `acde new` asks for whatever is missing: the directory, app or desktop, template, display name, whether to add a backend, Bun or Node.js (when both are installed), whether to install dependencies, and whether to run `git init`. Press Enter at each prompt to accept the defaults.

To skip the prompts, pass everything as options and add `--yes` (it still installs the dependencies; add `--no-install` to skip that):

```sh
acde new my-app --template html --label "My App" --yes
```

Available templates:

| Template | What it is |
| --- | --- |
| `html` | A plain web page (default); add `--backend` to include a backend |
| `desktop` | A desktop (see [Desktops](../guide/desktop.md)) |
| `react` `vue` `svelte` `solid` `preact` `vanilla` | create-vite templates. In 0.0.9 they ignore `--backend`; after 0.0.9, `--backend` adds `server.ts` |
| `next` `nuxt` `sveltekit` `astro` | Each framework's official scaffolding tool |

Framework templates run the latest version of the framework's scaffolding tool through your package manager, then add `acde.config.jsonc`.

## Run

`acde dev` runs your app in the runtime, acdebin-dbg, which the installer set up next to acde (inside the Dopame virtual machine it is already on PATH). `acde doctor` checks that it is there and works on this machine; see [The runtime](install.md#the-runtime).

```sh
cd my-app
acde dev
```

`acde dev` builds the project, starts acdebin-dbg, and opens a window on your computer with your app inside. Leave it running, then edit and save `index.html` or `src/main.js`; the window reloads automatically.

Press Ctrl+C or close the window to stop, or run `acde stop` from another terminal in the project directory.

> In the built-in templates, `package.json` has three scripts, `dev`, `build`, and `check`, which run `acde dev` / `acde build` / `acde check`. Framework templates leave the framework's own scripts alone and add `acde:dev`, `acde:build`, and `acde:check` instead.

## Add a capability

Let's have the app keep a file of its own. This example uses the `html` template; in a framework template, add only the `capabilities` line to its `acde.config.jsonc` (it has no `entry`, and should not get one) and put the code in one of the framework's source files.

First, request the `fs` capability in `acde.config.jsonc`:

```jsonc
{
  "type": "app",
  "id": "my-app",
  "label": "My App",
  "icon": "files",
  "entry": "index.html",
  "capabilities": { "fs": true }
}
```

Then in `src/main.js`:

```js
import { fs } from 'acde:fs'

const status = document.querySelector('#status')
await fs.writeFile('private', 'hello.txt', 'Hello from my app')
const { text } = await fs.readText('private', 'hello.txt')
const roots = await fs.roots()
status.textContent = `${text} (roots: ${roots.map((r) => r.id).join(', ')})`
```

Save, and after the window reloads you'll see `Hello from my app (roots: private)`. With `"fs": true` an app gets a private folder of its own (the root `private`) and whatever folder the user picks for it. The user's shared folders, such as Desktop and Downloads, are named in the config and approved by the user before the app gets them; see [Files and folders](../guide/files.md). Importing a capability you haven't requested fails outright.

## Build and check

```sh
acde check   # check the config and entry
acde build   # build into .acde/
```

`.acde/` is the **package** the runtime understands: a directory with a `package.json` whose `acde` field is the **manifest** (what the package contains), plus the build output for the web pages and backend. To install the app into the Dopame desktop on your machine, use `acde install`; see [Local install](../guide/install.md).

## Next steps

- [Project layout](project.md)
- [Configuration](../guide/config.md)
- [Backend](../guide/backend.md)
