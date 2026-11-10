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
}

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
- The capability name an app requests is the **service name** (the key in the config's `services`), not the namespace.
