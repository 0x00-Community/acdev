# Project layout

A project created with `acde new my-app --backend`:

```text
my-app/
├── acde.config.jsonc    app config: id, name, icon, entry, capabilities
├── package.json
├── index.html           entry page
├── src/main.js
├── server.ts            backend (optional; not on Windows yet)
├── public/              static files copied as is (optional)
└── .acde/               build output, kept out of git
```

## Config and manifest

- **`acde.config.jsonc`** is the config you write. It's only read at build time. `"type"` is `"app"` (a windowed app) or `"desktop"` (a desktop).
- The **manifest** is the `acde` field of `package.json` in the build output, `.acde/`. That directory is a **package**: what the runtime runs. The manifest is the only thing the runtime reads.

`acde build` turns the former into the latter. Most of the time you only need to care about the config; for the manifest format, see [Manifest](../reference/manifest.md).

A directory without `acde.config.jsonc` can still be built:

- If the `acde` field in `package.json` has `apps`, it's treated as a **handwritten package** and used as is (only checked).
- Otherwise it's treated as a default app: the entry is `index.html`, the id is derived from `name` in `package.json`, and the display name comes from `displayName` or `productName`.

## Build output

After building the app `my-app`:

```text
.acde/
├── package.json         manifest
├── web/                 web pages, served at /app/my-app/ in the runtime
└── backend/
    ├── server.js        bundled backend
    ├── package.json     {"type": "module"}
    └── acde-listen.js   preload that turns the backend's listen into a unix socket
```

A desktop project produces `desktop/` (served at `/desktop/<id>/`), `services/<name>.js`, and `apps/<id>/{web,backend}` for the apps it bundles.

## JavaScript runtime and package manager

Whether a project runs on Bun or Node.js is decided by its package manager: `bun` → Bun; `npm` / `pnpm` / `yarn` → Node.js. For an existing project, acde looks at the lockfile, then at the `packageManager` field in `package.json`. `acde new` writes `packageManager` for you.

On Node.js, acde bundles with the project's own Vite (which is why the built-in templates add `vite` as a dev dependency under npm / pnpm / yarn); on Bun it uses `Bun.build`. The bundling rules are the same on both.

## SDK

The project's dev dependencies include `@dopame/acde-api`, the SDK version this acde was built with, as a tarball from `https://pkgs.dopame.ai/acdert/<version>/` (so the project installs on any machine and in CI). It provides:

- The JSON Schema for `acde.config.jsonc` (editor completion)
- TypeScript types for all `acde:` modules and the manifest
- `load()`: load an `acde:` module optionally
- The Vite plugin `@dopame/acde-api/vite`

To reference the types in a JS file:

```js
/// <reference types="@dopame/acde-api" />
```

In a TypeScript project, add `"@dopame/acde-api"` to `compilerOptions.types` in `tsconfig.json`.
