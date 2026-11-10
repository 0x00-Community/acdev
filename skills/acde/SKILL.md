---
name: acde
description: Build, run, debug and test apps and desktops for Dopame OS with the acde CLI and its runtime, acdert. Use when a project has an acde.config.jsonc, imports an acde: module (acde:fs, acde:window, ...) or depends on @dopame/acde-api, and when the user mentions acde, acdert or Dopame OS, or asks to create, run, inspect, screenshot, drive or end-to-end test a Dopame app or desktop.
---

# acde

A Dopame OS app is a web project: HTML, CSS and JS in any framework, optionally with a Bun or Node.js backend. `acde` is the developer CLI (create, check, build, run, inspect, test). `acdert` is the runtime that draws the desktop and the apps; `acde dev` starts it. The relation is wrangler to workerd.

This skill ships inside acde and describes the version it came with. When it and the CLI disagree, the CLI is right: `acde` with no arguments prints the usage of every command.

## Check the environment first

1. `acde` must be on PATH. If it is not, follow [Install](references/start/install.md).
2. `acde dev` and `acde test` need the runtime. acde finds it through the `ACDERT` variable (a path to the binary) or as `acdert` on PATH. acdert is **not** part of acde and is not downloaded by its installer: it comes with the Dopame virtual machine. Without it, `acde new`, `acde check` and `acde build` still work, and `acde dev` says what is missing. Do not look for another way to get the runtime; tell the user it is missing.
3. A project runs on Bun when its package manager is bun, and on Node.js with npm, pnpm or yarn. `acde test` needs Bun.

## What is not like a browser

acdert has its own renderer and is not Chromium. Standard APIs follow the spec, and what the runtime lacks is absent rather than faked. Before relying on anything beyond the DOM, `fetch` and storage, read [Web compatibility](references/reference/web.md). The mistakes to avoid:

- **No CDN.** Images, fonts and ES modules load only from the app's own files. Bundle every dependency.
- **Missing APIs**: Web Workers, Service Workers, `crypto.subtle`, OffscreenCanvas, fullscreen, pointer lock. `confirm()` returns `false` and `prompt()` returns `null`; build dialogs in the page.
- **System access goes through `acde:` modules only** (`import { fs } from 'acde:fs'`), and only for capabilities the config requests. There is no global object. Importing a module that was not requested fails. See [Capabilities](references/guide/capabilities.md).
- **The backend has no TCP port.** A backend's `listen(port)` becomes a unix socket, and the page reaches it with a same-origin `fetch('/api/…')`. Do not `curl localhost`. See [Backend](references/guide/backend.md).
- **No developer tools.** Use the commands below to look at pages.
- **Platforms differ.** A capability a platform lacks fails to import. See [Platforms](references/reference/platforms.md).

## The working loop

Create a project without prompts (`--yes` asks nothing; without it `acde new` waits for answers in a terminal):

```sh
acde new my-app --template html --label "My App" --install --yes
```

Run it. `acde dev` builds, starts acdert, and rebuilds and reloads on every change. It does not exit: start it in the background and keep it running while you work. Add `--headless` when no window is needed; pages still render and screenshots still work.

```sh
acde dev --headless
```

Look at what the app does, from another shell in the project directory:

```sh
acde inspect                      # the screen as text, every element with a ref
acde act w1.15 click              # act on a ref: click, type, key, drag, ...
acde shot my-app -o shot.png      # a PNG of the app's window; read it to see the page
acde console --level errors       # console.error and uncaught errors
acde network --failed             # requests that failed
acde eval my-app 'document.title' # run code in the page, print JSON
```

After a change, wait for the rebuild line in the `acde dev` output, then check `acde console --level errors` and look at the page (`acde inspect` or `acde shot`) before saying it works. A failed build prints one error line and the window keeps the last good build, so a page that did not change may mean the build failed.

Write end-to-end tests in `*.e2e.ts` with the Playwright-like API from `acde/test`, and run them with `acde test`: each test gets its own isolated headless session. See [Testing](references/guide/testing.md).

Before handing over: `acde check` (config and entry), `acde build` (the package in `.acde/`), and `acde test` if the project has tests.

## Rules

- Edit `acde.config.jsonc`, never the generated `.acde/package.json`.
- Request a capability in the config before importing its module.
- Keep `.acde/` out of git.
- In scripts and tests, select elements by role and name (the semantic tree), not by coordinates.
- An MCP server with the same tools is available as `acde mcp`; the CLI commands above need no setup, so prefer them unless the user has set MCP up. See [MCP](references/guide/mcp.md).

## References

Read the one that matches the task; each is self-contained.

Getting started:

- [Install](references/start/install.md): install, upgrade, uninstall, the runtime
- [First app](references/start/first-app.md): from `acde new` to a capability and a build
- [Project layout](references/start/project.md): files, config versus manifest, build output, the SDK

Guides:

- [Configuration](references/guide/config.md): `acde.config.jsonc` for apps and desktops
- [Frameworks](references/guide/frameworks.md): how React, Vue, Next.js, Nuxt, SvelteKit, Astro and others are built
- [Assets and icons](references/guide/assets.md): `public/`, icons
- [Backend](references/guide/backend.md): `export default { fetch }` or any server that listens
- [Capabilities](references/guide/capabilities.md): requesting and importing `acde:` modules
- [Windows](references/guide/window.md): `acde:window`: title, menus, closing, shortcuts
- [Files and folders](references/guide/files.md): `acde:fs` and the file pickers
- [Opening apps](references/guide/open.md): `acde:open`, default apps, file handlers
- [Desktops](references/guide/desktop.md): writing a desktop instead of an app
- [Services](references/guide/services.md): desktop services and the capabilities they provide
- [acde dev](references/guide/dev.md): what runs, reloading, several projects, `--desktop`
- [Debugging](references/guide/tools.md): `webs`, `eval`, `shot`, `screen`, `inspect`, `act`, `console`, `network`
- [Coding agents](references/guide/agents.md): this skill, `acde skills`, where it is installed
- [MCP](references/guide/mcp.md): `acde mcp` and its tools
- [Testing](references/guide/testing.md): `acde test`, locators, assertions, screenshots, traces
- [Local install](references/guide/install.md): `acde install`, where packages are looked up

Reference:

- [CLI](references/reference/cli.md): every command and option
- [acde.config.jsonc](references/reference/config.md): every config field
- [Manifest](references/reference/manifest.md): the `acde` field of a built package
- [acde: modules](references/reference/modules.md): signatures of every module
- [Service API](references/reference/service.md): `ServiceFactory` and its context
- [Testing API](references/reference/testing.md): fixtures, locators, assertions, settings
- [Web compatibility](references/reference/web.md): storage, network, what is unsupported
- [Environment variables](references/reference/env.md): acde, the runtime, app backends
- [Platforms](references/reference/platforms.md): what works on macOS, Windows, Linux and Dopame OS
