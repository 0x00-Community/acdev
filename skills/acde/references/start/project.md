# Project layout

A project created with `acde new my-app --backend`:

```text
my-app/
├── acde.config.jsonc    app config: id, name, icon, entry, capabilities
├── package.json
├── index.html           entry page
├── src/main.js
├── src/i18n.js         picks the language and fills in interface text
├── src/locales/         one message table per language: en.js, zh.js
├── server.ts            backend (optional)
├── public/              static files copied as is (optional)
└── .acde/               build output, kept out of git
```

## Interface languages

The `html` and `desktop` templates keep interface text out of the markup, in one table per language under `src/locales/` (`en.js`, `zh.js`, each `export default { key: 'text' }`). `src/i18n.js` uses only the platform, no library:

- `locale` is chosen from `navigator.language`: the exact tag if there is a table for it (`zh-TW.js`), else its base language (`zh`, via `Intl.Locale`), else `en`. A key a table lacks falls back to its English text.
- `t(key, values)` returns the text with `{name}` placeholders filled in.
- `translate()` sets `<html lang>` to `locale` and fills every element with a `data-i18n="key"` attribute; `index.html` ships with `lang="en"` until then.

To add a language, add `src/locales/<tag>.js` with the same keys as `en.js` and import it in `i18n.js`. Format dates and numbers with `Intl` and `locale` (`new Intl.DateTimeFormat(locale)`). Framework templates keep the UI their own scaffolder writes.

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

Whether a project runs on Bun or Node.js is decided by its package manager: `bun` → Bun; `npm` / `pnpm` / `yarn` → Node.js. For an existing project, acde looks at the lockfile, then at the `packageManager` field in `package.json`; with neither, the project runs on the runtime acde itself runs on. `acde new` writes `packageManager` for you.

On Node.js, acde bundles with the project's own Vite (which is why the built-in templates add `vite` as a dev dependency under npm / pnpm / yarn); on Bun it uses `Bun.build`. The bundling rules are the same on both.

## SDK

The project's dev dependencies include `@dopame/acde-api`, the SDK version this acde was built with, as a tarball from `https://calbin-1318886512.cos.ap-beijing.myqcloud.com/pkgs/acdert/<version>/` (so the project installs on any machine and in CI; the SDK is not on npm). `acde new` installs it. After upgrading acde, `acde check` and `acde dev` say when the project's SDK is older; `acde sdk update` brings it to the version this acde pairs with. It provides:

- The JSON Schema for `acde.config.jsonc` (editor completion)
- TypeScript types for all `acde:` modules and the manifest
- `load()`: load an `acde:` module optionally
- The Vite plugin `@dopame/acde-api/vite`

To reference the types in a JS file:

```js
/// <reference types="@dopame/acde-api/app" />
```

In a TypeScript project, add `"@dopame/acde-api/app"` to `compilerOptions.types` in `tsconfig.json`. A desktop's pages use `@dopame/acde-api/shell` instead, which adds the modules only a desktop gets; `@dopame/acde-api` declares all of them.
