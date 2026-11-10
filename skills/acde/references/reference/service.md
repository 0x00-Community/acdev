# Service API

The default export of a desktop service module is a `ServiceFactory`. See [Services](../guide/services.md) for usage.

```ts
type ServiceFactory = (context: ServiceContext) => ServiceInstance | Promise<ServiceInstance>

interface ServiceInstance {
  readonly api: Readonly<Record<string, object>>
  readonly sync?: readonly string[]
  close?(): unknown
}

interface ServiceContext {
  readonly name: string
  readonly package: string
  readonly state: string
  readonly native: Readonly<Record<string, unknown>> | null
  readonly env: Readonly<Record<string, string | undefined>>
  readonly inspect?: AcdeInspect
  log(line: string): void
  spawn(argv: readonly string[], options?: SpawnOptions): ServiceProcess
  import<K extends keyof ShellModuleTypes>(specifier: `acde:${K}`): Promise<{ readonly default: ShellModuleTypes[K] } & { readonly [N in K]: ShellModuleTypes[K] }>
}

// ShellModuleTypes: windows, packages, session, desktops, inspect, desktop, setDefault, permissions

interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  onLine?(line: string): void
  onExit?(code: number | null, signal: number | null): void
}

interface ServiceProcess {
  readonly pid: number
  write(text: string): boolean
  end(): void
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'): boolean
}
```

- `api`: namespace → object. Each namespace becomes the module `acde:<namespace>`; functions on the object become callable methods, and strings / numbers / booleans become read-only fields.
- `sync`: a list of `"namespace.method"` entries. These methods are called once when a page starts, the results are cached in the page, and from then on they return synchronously in the page (good for configuration that doesn't change).
- `close()`: called when the desktop stops.
- An app lists the **service name** (the key in the desktop config's `services`) in its own `services`. Name the namespace after the service: `acde check` judges an app's `import 'acde:<name>'` by the names in its `services`. A service name cannot be that of a system module or capability, and a namespace with such a name is left out.
- `import('acde:windows')`: resolves to the module (`{ windows, default }`) when the desktop's manifest entry grants it to this service (`"services": [{ "name": "clock", "modules": ["windows"] }]`, see [Manifest](manifest.md#desktopmanifest)); otherwise it rejects with `acde:windows is a shell module: list it in the modules of service "clock" in the desktop manifest`. A service cannot use a static `import` of an `acde:` module (the build rejects it). What a service gets can be smaller than what a page gets: its `acde:windows` has `list`, `focus`, `hide`, `show`, `close`, `kill`, `stats`, and `animate`, and no events.
