# Testing API

`acde/test` exports `test`, `expect`, `describe`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach`, and everything from `acde/driver`, including the types (`Fixtures`, `AppWindow`, `Locator`, `Acde`, `E2eSettings` and the option and result types below; `import { type AppWindow } from 'acde/test'`). `acde/driver` depends only on `node:` modules, so you can use it on its own in Node.js / Bun scripts.

## test

```ts
test(name: string, body: (fixtures: Fixtures) => unknown, options?: number | { timeout?: number }): void
test.only / test.skip / test.todo(name) / test.if(condition)

interface Fixtures {
  acde: Acde
  app: AppWindow | null
  home: string
  settings: E2eSettings
}
```

## expect

```ts
expect(locator: Locator): LocatorAssertions
expect(window: AppWindow): WindowAssertions
expect(value): bun:test Matchers
```

**LocatorAssertions** (all support `.not` and accept `{timeout}`):

`toBeVisible()` `toBeHidden()` `toHaveCount(n)` `toHaveText(text, {exact?})` `toContainText(text)` (text content, not the accessible name) `toHaveValue(text)` `toHaveState(state)` `toBeChecked()` `toBeDisabled()` `toBeEnabled()` `toBeFocused()` `toHaveAttribute(name, value?)` `toHaveScreenshot(name?, options?)`

**WindowAssertions**: `toBeOpen()` `toHaveTitle(text)` `toHaveScreenshot(name?, options?)`

`text` is a string or a RegExp. Screenshot options: `{maxDiffPixels, maxDiffPixelRatio, threshold, mask: Locator[], timeout}`.

## Acde

```ts
class Acde {
  static launch(options?: {
    dirs?: string[]; desktop?: string; app?: string; out?: string
    cwd?: string; env?: Record<string, string>; headless?: boolean
    timeout?: number; startTimeout?: number
  }): Promise<Acde>
  static attach(options?: { session?: number; cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<Acde>

  readonly desktop: AppWindow
  readonly trace: Trace
  window(match: string | { ref?: string; id?: number; app?: string; title?: string | RegExp }): AppWindow
  open(name: string, options?: { timeout?: number }): Promise<AppWindow>
  webs(): Promise<Web[]>
  windows(): Promise<InspectWindow[]>

  evaluate<T>(web: string, code: string): Promise<T>
  snapshot(options?): Promise<{ text; windows; trees }>
  query(options: { selector: string; window?: string; ref?: string; limit?: number; attributes?: string[] }): Promise<QueryResult>
  act(ref: string, action: InspectAction, arg?): Promise<{ ok: boolean; text: string }>
  run(steps): Promise<{ ok: boolean; text: string }>

  screenshot(web: string, options?: { path?: string }): Promise<Shot>
  screen(options?: { path?: string }): Promise<Shot>
  console(options?: { web?; since?; limit?; level? }): Promise<{ entries; next; dropped }>
  network(options?: { web?; since?; limit?; failed? }): Promise<{ entries; next; dropped }>
  waitForRequest(url: string | RegExp, options?: { method?; web?; timeout? }): Promise<RequestEntry>
  waitForConsole(text: string | RegExp, options?: { level?; web?; timeout? }): Promise<ConsoleEntry>

  emulate(options: { colorScheme?: 'light' | 'dark' | null; reducedMotion?: boolean | null }): Promise<...>
  chooseFolder(folder: string | null): Promise<void>
  chooseFiles(files: string | string[] | null): Promise<void>
  chooseSaveFile(file: string | null): Promise<void>
  route(url: string | RegExp, response: RouteResponse, options?: { method?; web?; times? }): Promise<number>
  unroute(id?: number): Promise<{ removed: number; left: number }>
  clipboard(): Promise<string>
  setClipboard(text: string): Promise<void>

  ready(): Promise<boolean>
  close(): Promise<void>
}
```

- `launch` starts an `acde dev` session and waits until the windows of all pages have appeared (120 seconds by default). `close()` sends SIGTERM, then SIGKILL after 10 seconds.
- `choose*` answers, in advance, the **next** picker of that kind the page opens; `null` means the user cancelled; relative paths resolve against the current directory.
- Call `waitFor*` before the action that triggers it.

### route

```ts
type RouteResponse =
  | { status?: number; statusText?: string; headers?: Record<string, string>; contentType?: string; body?: string | Uint8Array; json?: unknown }
  | { abort: true | string }
```

`url` is a glob (`**` matches anything, `*` matches anything except `/`; a glob starting with `/` is matched against the path plus query, otherwise against the whole URL) or a RegExp. Rules added later match first; a rule is removed automatically once its `times` are used up. Only fetch / XHR are affected, not WebSocket / EventSource.

## AppWindow

```ts
class AppWindow {
  getByRole(role: string, options?: RoleOptions): Locator
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator
  getByLabel / getByPlaceholder / getByTitle / getByAltText (text, options?): Locator
  getByTestId(id: string): Locator
  locator(selector: string): Locator

  info(options?): Promise<InspectWindow>
  isOpen(): Promise<boolean>
  waitFor(options?: { state?: 'open' | 'closed'; timeout?: number }): Promise<void>
  web(): Promise<string>
  evaluate<T>(code: string): Promise<T>
  snapshot(options?: { find?: string; diff?: boolean }): Promise<string>
  screenshot(options?: { path?: string; mask?: Locator[] }): Promise<Shot>

  press(keys: string): Promise<ActResult>
  focus() / minimize() / restore() / close(): Promise<ActResult>

  route / waitForRequest / waitForConsole / console / network  // as on Acde, scoped to this window
}

interface RoleOptions {
  name?: string | RegExp; exact?: boolean
  checked?: boolean; disabled?: boolean; selected?: boolean
  expanded?: boolean; pressed?: boolean; focused?: boolean; level?: number
}
```

`AppWindow` looks itself up in the window table again on every use, so it keeps working if the window is closed and reopened.

## Locator

```ts
class Locator {
  getByRole / getByText / getByLabel / … / locator(...)   // search within this element
  filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp }): Locator
  nth(index: number) / first() / last(): Locator

  count(): Promise<number>
  all(): Promise<Locator[]>
  isVisible(): Promise<boolean>
  textContent(): Promise<string>  // the text inside the element (what toHaveText compares)
  text() / name() / value() / states() / ref() / node(): Promise<...>
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>

  click(options?: { button?: 'left' | 'right'; clickCount?: 1 | 2; timeout?: number }): Promise<ActResult>
  dblclick() / hover() / focus() / clear(): Promise<ActResult>
  fill(text: string) / type(text: string) / press(keys: string): Promise<ActResult>
  scroll(dy?: number): Promise<ActResult>
  selectOption(values: string | string[]): Promise<ActResult>
  check() / uncheck() / setChecked(checked: boolean): Promise<void>
  dragTo(target: Locator): Promise<ActResult>
  screenshot(options?: { path?: string; mask?: Locator[] }): Promise<Shot>
}
```

When an action fails (`ok: false`), it is retried until the timeout, then `ActError` is thrown.

### Semantic tree limitations

Locators search the runtime's semantic tree, not the DOM:

- Elements with `opacity: 0` count as invisible.
- `getByText` compares accessible names.
- `<select>` can't be found by CSS (its box is 0 × 0); use `getByRole('combobox')` or `getByLabel`.

## Png

`Png.decode(bytes)`, `Png.encode(image)`, `Png.diff(actual, expected, {threshold})`: PNG encoding/decoding using only `node:zlib`, plus a pixelmatch-style comparison. The screenshot assertions are built on it.
