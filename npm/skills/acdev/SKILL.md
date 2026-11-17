---
name: acdev
description: Build, run, debug, and test apps and desktops for Dopame OS with the acdev CLI and its runtime, acdev runtime (built on acdert). Use when a project has an acde.config.jsonc, imports an acde: module (acde:fs, acde:window, ...) or depends on @dopame/acde-api, and when the user mentions acdev, acdert, or Dopame OS, or asks to create, run, inspect, screenshot, drive, or end-to-end test a Dopame app or desktop.
---

# acdev

A Dopame OS app is a web project: HTML, CSS, and JS in any framework, optionally with a Bun or Node.js backend. `acdev` is the developer CLI (create, check, build, run, inspect, test). `acdev runtime` is the runtime that draws the desktop and the apps (built on the acdert runtime library); `acdev dev` starts it. The relation is wrangler to workerd.

This skill ships inside acdev and describes the version it came with. When it and the CLI disagree, the CLI is right: `acdev --help` prints every command, and `acdev <command> --help` that command's options.

## Check the environment first

Run `acdev doctor`, in the project directory when there is one. It checks what follows and more (the runtime draws a test frame on the GPU), prints one line per check (`ok`, `warn`, `error` or `skip`) with a `fix:` line under each problem, and exits with code 1 on an error. Run it again whenever `acdev dev`, `acdev test` or the MCP `start` does not come up, before guessing. `acdev doctor --fix` then fixes what acdev may (the skill, `.acde/` in `.gitignore`, the sessions directory) and asks before what downloads, installs or stops something; without a terminal it skips those unless given `--yes`, which you pass only when the user agreed. Approvals, GPU drivers and the project's code it leaves to you and the user. See [Check the setup](references/guide/doctor.md).

1. `acdev` must be on PATH. If it is not, follow [Install](references/start/install.md).
2. `acdev dev` and `acdev test` need the runtime, acdebin-dbg. The acdev installer sets up the acdev runtime release that acdev pairs with next to it; acdev finds `ACDEV_RUNTIME` (a path to the binary) first, then that one, then `acdev runtime` (or an older `acdert`) on PATH (in the Dopame virtual machine it is already there). If `acdev doctor` finds none, or one that does not run, run the acdev installer again (`acdev doctor --fix --yes` does that for an installed acdev); only if it cannot run on this machine, offer the steps in [Install the runtime by hand](references/start/install.md#install-the-runtime-by-hand), and use them only if the user agrees. Get it from nowhere else. Without it, `acdev new`, `acdev check`, and `acdev build` still work, and `acdev dev` says what is missing.
3. A project runs on Bun when its package manager is bun, and on Node.js with npm, pnpm, or yarn. `acdev test` needs Bun.

## What is not like a browser

acdert has its own renderer and is not Chromium. Standard APIs follow the spec, and what the runtime lacks is absent rather than faked. Before relying on anything beyond the DOM, `fetch`, and storage, read [Web compatibility](references/reference/web.md). The mistakes to avoid:

- **No modules from a CDN.** ES modules load only from the app's own files (`import('https://…')` fails): bundle every code dependency. Images, stylesheets and fonts can come from other hosts, as in a browser.
- **Missing APIs**: Web Workers, Service Workers, `crypto.subtle`, WebGL, OffscreenCanvas, fullscreen, pointer lock. `confirm()` returns `false` and `prompt()` returns `null`; build dialogs in the page.
- **System access goes through `acde:` modules only** (`import { fs } from 'acde:fs'`), and only for capabilities the config requests. There is no global object. Importing a module that was not requested fails. See [Capabilities](references/guide/capabilities.md).
- **The backend has no TCP port.** A backend's `listen(port)` becomes a unix socket, and the page reaches it with a same-origin `fetch('/api/…')`. Do not `curl localhost`. See [Backend](references/guide/backend.md).
- **Developer tools.** In 0.0.9 there are none: use the commands below to look at pages; after 0.0.9, F12 in an `acdev dev` window or `acdev devtools` opens the DevTools of Chrome or Edge on the page, over the Chrome DevTools Protocol. See [acdev dev](references/guide/dev.md#devtools).
- **Platforms differ.** An app that requires a capability the platform lacks does not start there; one that lists it as optional finds that `import('acde:<name>')` rejects. See [Platform support](references/reference/platforms.md).

## The working loop

Create a project without prompts (`--yes` asks nothing; without it `acdev new` waits for answers in a terminal):

```sh
acdev new my-app --template html --label "My App" --yes
```

Run it. `acdev dev` builds, starts acdev runtime, and rebuilds and reloads on every change. It does not exit: start it in the background and keep it running while you work; `acdev stop` ends it. Add `--headless` when no window is needed; pages still render and screenshots still work. It is ready when `acdev webs`, run from the project directory, lists the app's page.

```sh
acdev dev --headless
```

Look at what the app does, from another shell in the project directory:

```sh
acdev inspect                      # the screen as text, every visible element with a ref
acdev query 'form button'          # elements by CSS selector, hidden ones too, each with a ref
acdev act w1.15 click              # act on a ref: click, type, key, drag, ...
acdev shot my-app -o shot.png      # a PNG of the app's window; read it to see the page
acdev console --level errors       # console.error and uncaught errors
acdev network --failed             # requests that failed
acdev eval my-app 'document.title' # run code in the page, print JSON
```

After a change, wait for the rebuild line in the `acdev dev` output, then check `acdev console --level errors` and look at the page (`acdev inspect` or `acdev shot`) before saying it works. A failed build prints one error line and the window keeps the last good build, so a page that did not change may mean the build failed.

Write end-to-end tests in `*.e2e.ts` with the Playwright-like API from `acdev/test`, and run them with `acdev test`: each test gets its own isolated headless session. See [Testing](references/guide/testing.md).

Before handing over: `acdev check` (config and entry), `acdev build` (the package in `.acde/`), and `acdev test` if the project has tests.

## Rules

- Edit `acde.config.jsonc`, never the generated `.acde/package.json`.
- Request a capability in the config before importing its module.
- Declaring a capability grants it. Only the camera and the microphone ask the user, the first time a page calls `getUserMedia()`; the call waits for the answer: run `acdev permissions`, then `acdev allow` or `acdev deny`. Answering is the user's decision, and it is kept for the app: allow only what the user asked for or agreed to, and say what you allowed. See [Capabilities](references/guide/capabilities.md#camera-and-microphone).
- In `acde:fs` a root is an id, not a path. `"fs": true` gives the app its own folder, the root `private`: keep the app's working files there. See [Files and folders](references/guide/files.md).
- An app that lists `services` only runs in the desktop that provides them: `acdev dev` in the app project alone does not start it, `acdev dev --desktop <dir>` does. See [Services](references/guide/services.md).
- Keep `.acde/` out of git.
- In scripts and tests, select elements by role and name (the semantic tree), not by coordinates.
- An MCP server with the same tools is available as `acdev mcp`; the CLI commands above need no setup, so prefer them unless the user has set MCP up. See [MCP](references/guide/mcp.md).

## References

Read the one that matches the task; each is self-contained.

Getting started:

- [Install](references/start/install.md): install, upgrade, uninstall, the runtime, and the Dopame desktop
- [First app](references/start/first-app.md): from `acdev new` to a capability and a build
- [Project layout](references/start/project.md): files, config versus manifest, build output, the SDK

Guides:

- [Configuration](references/guide/config.md): `acde.config.jsonc` for apps and desktops
- [Frameworks](references/guide/frameworks.md): how React, Vue, Next.js, Nuxt, SvelteKit, Astro, and others are built
- [Assets and icons](references/guide/assets.md): `public/`, icons
- [Backend](references/guide/backend.md): `export default { fetch }` or any server that listens
- [Capabilities](references/guide/capabilities.md): requesting and importing `acde:` modules
- [Windows](references/guide/window.md): `acde:window`: title, menus, closing, shortcuts
- [Files and folders](references/guide/files.md): `acde:fs` and the file pickers
- [Opening apps](references/guide/open.md): `acde:open`, default apps, file handlers
- [Desktops](references/guide/desktop.md): writing a desktop instead of an app
- [Services](references/guide/services.md): desktop services and the capabilities they provide
- [acdev dev](references/guide/dev.md): what runs, reloading, several projects, `--desktop`
- [Check the setup](references/guide/doctor.md): `acdev doctor`, what it checks, what to do about each finding, and what `--fix` repairs
- [Debugging](references/guide/tools.md): `webs`, `eval`, `shot`, `screen`, `inspect`, `query`, `act`, `console`, `network`, `permissions`, `allow`, `deny`, `revoke`, and `devtools` (after 0.0.9)
- [Coding agents](references/guide/agents.md): this skill, `acdev skills`, where it is installed
- [MCP](references/guide/mcp.md): `acdev mcp` and its tools
- [Testing](references/guide/testing.md): `acdev test`, locators, assertions, screenshots, traces
- [Local install](references/guide/install.md): `acdev install`, `acdev uninstall`, where packages are looked up

Reference:

- [CLI](references/reference/cli.md): every command and option
- [acde.config.jsonc](references/reference/config.md): every config field
- [Manifest](references/reference/manifest.md): the `acde` field of a built package
- [acde: modules](references/reference/modules.md): signatures of every module
- [Service API](references/reference/service.md): `ServiceFactory` and its context
- [Testing API](references/reference/testing.md): fixtures, locators, assertions, settings
- [Web compatibility](references/reference/web.md): storage, network, what is unsupported
- [Environment variables](references/reference/env.md): acdev, the runtime, app backends
- [Platform support](references/reference/platforms.md): what works on macOS, Windows, Linux, and Dopame OS
