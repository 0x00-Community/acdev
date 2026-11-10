# acde.config.jsonc

The project configuration. The JSON Schema is at `@dopame/acde-api/config.schema.json`, and the TypeScript type is `AcdeConfig`:

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
| `public` | string | `"public"` | Directory of static files copied as is |

## AppConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | Derived from the package name | `[a-z0-9][a-z0-9-]*` |
| `label` | string | | Display name |
| `icon` | icon name \| path | `"app"` | See [Icons](../guide/assets.md#icons) |
| `entry` | string | `"index.html"` | HTML, or a module whose default export is a `WindowApp`; omit when using a framework |
| `framework` | `Framework` | `"auto"` | See below |
| `capabilities` | `Capabilities` | `{}` | See [Manifest](manifest.md#capabilities) |
| `size` | `[number, number]` | `[800, 600]` | Content area in logical pixels, positive integers |
| `frame` | boolean | `true` | System title bar |
| `multiple` | boolean | `false` | Allow multiple windows |
| `mimeTypes` | string[] | `[]` | `type/subtype` or `type/*` |
| `heapMb` | number | 256 | JS heap limit per window, ≥ 32 |
| `backend` | `false` \| `{entry?, port?}` | Detected automatically | See [Backend](../guide/backend.md) |

`Framework`: `auto` `none` `next` `nuxt` `sveltekit` `astro` `react-router` `remix` `angular` `vite` `cra` `script`.

## DesktopConfig

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` / `label` / `description` | string | | |
| `entry` | string | `"index.html"` | The desktop page |
| `heapMb` | number | 1024 | |
| `services` | `Record<string, string>` | | Service name → module path |
| `apps` | `WindowAppConfig[]` | | Bundled apps; `id` and `entry` are required |
