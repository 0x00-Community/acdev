# First app

## Create

```sh
acdev new my-app
```

In a terminal, `acdev new` asks for whatever is missing: the directory, app or desktop, template, display name, whether to add a backend, Bun or Node.js (when both are installed), whether to install dependencies, and whether to run `git init`. Press Enter at each prompt to accept the defaults.

`bun create acde` (or `npm create acde`, `pnpm create acde`, `yarn create acde`) does the same: it runs `acdev new` with the same options, and the project uses the package manager you ran it with. If acdev is not installed yet, it offers to run the [installer](install.md) first (in a terminal; otherwise it prints the install command and exits).

```sh
bun create acde my-app
```

To skip the prompts, pass everything as options and add `--yes` (it still installs the dependencies; add `--no-install` to skip that):

```sh
acdev new my-app --template html --label "My App" --yes
```

Available templates:

| Template | What it is |
| --- | --- |
| `html` | A plain web page (default); add `--backend` to include a backend |
| `desktop` | A desktop (see [Desktops](../guide/desktop.md)) |
| `react` `vue` `svelte` `solid` `preact` `vanilla` | create-vite templates. `--backend` adds `server.ts` |
| `next` `nuxt` `sveltekit` `astro` | Each framework's official scaffolding tool |

Framework templates run the latest version of the framework's scaffolding tool through your package manager, then add `acde.config.jsonc`.

## Run

`acdev dev` runs your app in the runtime, which the installer set up next to acdev. `acdev doctor` checks that it is there and works on this machine; see [The runtime](install.md#the-runtime).

```sh
cd my-app
acdev dev
```

`acdev dev` builds the project, starts the runtime, and opens a window on your computer with your app inside. Leave it running, then edit and save `index.html` or `src/main.js`; the window reloads automatically.

Press Ctrl+C or close the window to stop, or run `acdev stop` from another terminal in the project directory.

> In the built-in templates, `package.json` has three scripts, `dev`, `build`, and `check`, which run `acdev dev` / `acdev build` / `acdev check`. Framework templates leave the framework's own scripts alone and add `acde:dev`, `acde:build`, and `acde:check` instead.

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
acdev check   # check the config and entry
acdev build   # build into .acde/
```

`.acde/` is the **package** the runtime understands: a directory with a `package.json` whose `acde` field is the **manifest** (what the package contains), plus the build output for the web pages and backend. To install the app into the Dopame desktop on your machine, use `acdev install`; see [Local install](../guide/install.md).

## Next steps

- [Project layout](project.md)
- [Configuration](../guide/config.md)
- [Backend](../guide/backend.md)
