# First app

## Create

```sh
acde new my-app
```

In a terminal, `acde new` asks for whatever is missing: app or desktop, template, display name, whether to add a backend, whether to install dependencies, and whether to run `git init`. Press Enter at each prompt to accept the defaults.

To skip the prompts, pass everything as options and add `--yes`:

```sh
acde new my-app --template html --label "My App" --install --yes
```

Available templates:

| Template | What it is |
| --- | --- |
| `html` | A plain web page (default); add `--backend` to include a backend (backends don't run on Windows yet) |
| `desktop` | A desktop (see [Desktops](../guide/desktop.md)) |
| `react` `vue` `svelte` `solid` `preact` `vanilla` | create-vite templates |
| `next` `nuxt` `sveltekit` `astro` | Each framework's official scaffolding tool |

Framework templates run the latest version of the framework's scaffolding tool through your package manager, then add `acde.config.jsonc`.

## Run

`acde dev` needs the runtime, acdert, which is not part of acde. Inside the Dopame virtual machine it is already there; on your own computer, [install the runtime](install.md#install-the-runtime-on-your-own-computer) first.

```sh
cd my-app
acde dev
```

`acde dev` builds the project, starts acdert, and opens a window on your computer with your app inside. Leave it running, then edit and save `index.html` or `src/main.js`; the window reloads automatically.

Press Ctrl+C or close the window to stop.

> In the built-in templates, `package.json` has three scripts, `dev`, `build`, and `check`, which run `acde dev` / `acde build` / `acde check`. Framework templates leave the framework's own scripts alone and add `acde:dev`, `acde:build`, and `acde:check` instead.

## Add a capability

Let's have the app list the user's folders. This example uses the `html` template; in a framework template, add only the `capabilities` line to its `acde.config.jsonc` (it has no `entry`, and should not get one) and put the code in one of the framework's source files.

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
const roots = await fs.roots()
status.textContent = roots.map((r) => r.label).join(', ')
```

Save, and after the window reloads you'll see the names of folders such as Desktop and Downloads. Importing a capability you haven't requested fails outright.

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
