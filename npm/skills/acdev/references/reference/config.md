# acde.config.jsonc

The project configuration. The JSON Schema is `acde.config.schema.json`, which `acdev new` puts next to it (it comes with acdev), and the TypeScript type is `AcdeConfig` (from `@dopame/acde-api`):

```ts
type AcdeConfig = AppConfig | DesktopConfig
```

## Common fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `$schema` | string | | Path to the JSON Schema |
| `type` | `"app"` \| `"desktop"` | | Required |
| `name` | string | `name` from `package.json` | Package name |
| `version` | string | `version` from `package.json` | |
| `apiLevel` | integer ≥ 1 | The SDK's `API_LEVEL` (1) | The contract level; `acdev build` writes it into the manifest. Leave it out |
| `public` | string | `"public"` | Directory of static files copied as is |

## AppConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | Derived from the package name | `[a-z0-9][a-z0-9-]*` |
| `label` | string | | Display name |
| `icon` | icon name \| path | `"app"` | See [Icons](../guide/assets.md#icons) |
| `entry` | string | `"index.html"` | HTML, or a module whose default export is a `WindowApp`; omit when using a framework |
| `framework` | `Framework` | `"auto"` | See below |
| `capabilities` | `Capabilities` | `{}` | System capabilities; see [Manifest](manifest.md#capabilities). A desktop service's name here is an error |
| `optional` | string[] | `[]` | Names that are also in `capabilities`: the app runs without them and reaches them with a dynamic `import('acde:<name>')` |
| `services` | string[] | `[]` | Desktop services the app uses, imported as `acde:<name>`; not the name of a system module |
| `size` | `[number, number]` | `[800, 600]` | Content area in logical pixels, positive integers. When `acdev dev` runs the app alone, the size the host window opens at (the app fills it); not applied with `--headless` |
| `frame` | boolean | `true` | System title bar |
| `multiple` | boolean | `false` | Allow multiple windows |
| `mimeTypes` | string[] | `[]` | `type/subtype` or `type/*` |
| `schemes` | string[] | `[]` | URL schemes of links the app opens: `[a-z][a-z0-9+.-]*`, no colon, not `file` |
| `requests` | string[] | `[]` | Request kinds the app accepts from `open()`: `[a-z][a-z0-9-]*`, not `open-file` or `open-link` |
| `heapMb` | number | 256 | JS heap limit per window, ≥ 32 |
| `backend` | `false` \| `{entry?, port?}` | Detected automatically | See [Backend](../guide/backend.md) |

`Framework`: `auto` `none` `next` `nuxt` `sveltekit` `astro` `react-router` `remix` `angular` `vite` `cra` `script`.

## DesktopConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` / `label` / `description` | string | | |
| `entry` | string | `"index.html"` | The desktop page |
| `heapMb` | number | 1024 | |
| `services` | `Record<string, string \| ServiceConfig>` | | Service name → module path, or `{ module, modules? }`: the module path and the shell modules the service gets from `ctx.import()`; see [Services](../guide/services.md#shell-modules-in-a-service) |
| `apps` | `WindowAppConfig[]` | | Bundled apps (system apps): the `AppConfig` fields except `framework`; `id` and `entry` are required, and `capabilities` may name shell modules |
