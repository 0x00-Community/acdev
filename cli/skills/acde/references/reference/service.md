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
  import<K extends keyof ServiceModuleTypes>(specifier: `acde:${K}`): Promise<{ readonly default: ServiceModuleTypes[K] } & { readonly [N in K]: ServiceModuleTypes[K] }>
}

// ServiceModuleTypes: windows, packages, session, desktops, inspect, setDefault, and desktop with apps() only

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
- An app lists the **service name** (the key in the desktop config's `services`) in its own `services`, and the runtime then gives it every namespace of that service. `acde check` and `acde build` let an import of a namespace that is not the service's own name pass with a `note:`, because they cannot know a service's namespaces (see [Services](../guide/services.md#call-it)). A service name cannot be that of a system module or capability, and a namespace with such a name is left out.
- `import('acde:windows')`: resolves to the module (`{ windows, default }`) when the desktop grants it to this service: `"services": { "clock": { "module": "services/clock.ts", "modules": ["windows"] } }` in `acde.config.jsonc`, which `acde build` writes into the manifest as `"services": [{ "name": "clock", "modules": ["windows"] }]` (see [Manifest](manifest.md#desktopmanifest)). Otherwise it rejects with `acde:windows is a shell module: list it in the modules of service "clock" in the desktop manifest`. A service cannot use a static `import` of an `acde:` module (the build rejects it). A service gets the modules a desktop page gets, with two exceptions: `acde:desktop` is `apps()` only, and `acde:permissions` is not given. Calls that the types declare as promises return promises in a service too. See [Services](../guide/services.md#shell-modules-in-a-service).
