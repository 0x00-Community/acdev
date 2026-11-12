# Testing API

`acde/test` exports `test`, `expect`, `describe`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach`, and everything from `acde/driver`, including the types (`Fixtures`, `AppWindow`, `Locator`, `Acde`, `E2eSettings` and the option and result types below; `import { type AppWindow } from 'acde/test'`). `acde/driver` depends only on `node:` modules, so you can use it on its own in Node.js / Bun scripts.

## test

```ts
test(name: string, body: (fixtures: Fixtures) => unknown, options?: TestOptions): void
test(name: string, options: TestOptions, body: (fixtures: Fixtures) => unknown): void
test.only / test.skip / test.todo(name) / test.if(condition)

type TestOptions = number | {
  timeout?: number
  size?: [width: number, height: number]
  localStorage?: Record<string, string>
}

interface Fixtures {
  acde: Acde
  app: AppWindow | null
  home: string
  settings: E2eSettings
}
```

A number is the timeout in milliseconds. `localStorage` is written before the page loads (`app.seedLocalStorage`), then `size` sets the page's size (`app.resize`); both need the `app` fixture.

## expect

```ts
expect(locator: Locator): LocatorAssertions
expect(window: AppWindow): WindowAssertions
expect(value): bun:test Matchers
expect.poll(read: () => T | Promise<T>, options?: { timeout?: number; message?: string }): bun:test Matchers, each returning a Promise
expect.soft(locator | window | value): the same assertions; a failure is recorded and the test fails at its end
```

**LocatorAssertions** (all support `.not` and accept `{timeout}`):

`toBeVisible()` `toBeHidden()` `toHaveCount(n)` `toHaveText(text, {exact?})` `toContainText(text)` `toHaveValue(text)` `toHaveState(state)` `toBeChecked()` `toBeDisabled()` `toBeEnabled()` `toBeFocused()` `toHaveAttribute(name, value?)` `toHaveClass(text)` `toHaveCSS(property, text)` (the computed style) `toHaveJSProperty(name, value)` `toBeEmpty()` `toBeEditable()` `toBeInViewport({ratio?})` `toHaveScreenshot(name?, options?)`

**WindowAssertions**: `toBeOpen()` `toHaveTitle(text)` `toHaveScreenshot(name?, options?)`

`text` is a string or a RegExp. `toHaveText` and `toContainText` both compare the element's text content, not its accessible name. Screenshot options: `{maxDiffPixels, maxDiffPixelRatio, threshold, mask: Locator[], timeout}`.

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
  act(ref: string, action: InspectAction, arg?): Promise<ActResult>
  run(steps): Promise<ActResult>

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
  pointer(x: number, y: number): Promise<{ x: number; y: number }>  // a real pointer move to screen coordinates
  clipboard(): Promise<string>
  setClipboard(text: string): Promise<void>

  addInitScript(code: string, options?: { web?: string; once?: boolean }): Promise<number>
  removeInitScript(id?: number): Promise<{ removed: number; left: number }>
  reload(web: string): Promise<void>
  resize(web: string, width: number, height: number): Promise<{ width: number; height: number }>
  answerDialog(web: string, answer?: { accept?: boolean; text?: string }): Promise<void>
  dialogs(options?: { web?: string }): Promise<Dialog[]>
  waitForDialog(options?: { web?: string; type?: 'alert' | 'confirm' | 'prompt'; timeout?: number }): Promise<Dialog>
  input(web: string, events: InputEvent[]): Promise<ActResult>

  permissions(): Promise<{ pending: PermissionPrompt[]; decisions: PermissionDecision[] }>
  waitForPrompt(match?: { app?: string; capability?: string; timeout?: number }): Promise<PermissionPrompt>
  allow(match?: { app?: string; capability?: string; timeout?: number }): Promise<PermissionPrompt>
  deny(match?: { app?: string; capability?: string; timeout?: number }): Promise<PermissionPrompt>
  answer(prompt: PermissionPrompt | number, allow: boolean): Promise<void>
  revoke(app: string, capability: string): Promise<boolean>
  drop(files: string | string[], options?: { web?: string; x?: number; y?: number }): Promise<{ web; window; files }>

  ready(): Promise<boolean>
  readonly closed: boolean
  close(): Promise<void>
}

interface ActResult {
  ok: boolean
  text: string
  ended?: true
}
```

- `launch` starts an `acde dev` session on the project's own runtime (Bun or Node.js) and waits until the windows of all pages have appeared, or an approval prompt waits (`startTimeout`, 120 seconds by default). When the session does not start, it ends that `acde dev` and throws a `LaunchError` (an `Error`, exported by `acde/driver`). Its message says how far the start got and ends with the last 40 lines of the output of `acde dev`; `logs` holds the whole output (`error.logs.tail(5000).text`), and `phase` is:
  - `'exited'`: `acde dev exited (1) before it was ready:`; `code` is the exit code (`null` in the other phases).
  - `'session'`: `acde dev (pid 4242) did not register a session within 120 s in <dir>`, then the line `no session yet: its build did not finish, or acdert did not start listening; last output:`.
  - `'window'`: `acde dev did not start within 120 s:`, then the line `acdert runs and answers, but no window appeared (pages: 0, windows: 0) and no approval prompt waits; last output:`.
  - `'failed'`: anything else that went wrong while it waited (the message is that error's, which is also the `cause`).
- `close()` ends the session that `launch` started: it asks acdert to quit, so acdert and `acde dev` end on their own. On macOS and Linux it also sends SIGTERM to `acde dev`, then SIGKILL after 10 seconds. On Windows it waits up to 10 seconds for them to exit, then ends `acde dev` and acdert together (the whole process tree). On a session from `attach` it only disconnects; requests still waiting fail at once.
- `act` answers `ok: false` when the action was not done. In a session that runs a single app, closing the app's only window ends the session, by design: the `close` that did it resolves with `ok: true`, `ended: true` and the text `closed w1; acdert exited with it, so acde dev <pid> ended`; `closed` becomes true, and every later request rejects with `acde dev <pid> is no longer connected`. Any other request during which the runtime goes away rejects with `acdert closed the connection` (also a `close` in a desktop session, and a `run` whose steps close the window).
- `choose*` answers, in advance, the **next** picker of that kind the page opens; `null` means the user cancelled; relative paths resolve against the current directory. A headless session has no picker dialog, so a picker opened without an answer fails and the page sees it as cancelled.
- Call `waitFor*` before the action that triggers it.
- `addInitScript` registers code that runs before a page's own scripts on every load (`once`: on the next load only); `web` is a page name or an app id, and without it every page runs the code. It returns an id for `removeInitScript`, which removes every script when no id is given.
- `answerDialog` answers the page's next `alert` / `confirm` / `prompt` in advance: `accept: false` cancels, `text` is what a `prompt` answers. Without an answer `confirm` gives false and `prompt` null. `Dialog` is `{ type, message, defaultValue, answered, accept, text }`.
- `input` sends raw events at page coordinates: `{ type: 'move' | 'down' | 'up' | 'wheel', x, y, button?, dx?, dy? }`, `{ type: 'keydown' | 'keyup', key }` and `{ type: 'text', text }`. `app.mouse` and `app.keyboard` are built on it.
- Camera and microphone prompts (`PermissionPrompt` is `{ id, app, label, capability, reason }`, `PermissionDecision` is `{ app, label, capability, decision: 'granted' | 'denied' }`): `allow` and `deny` wait for a prompt that matches (any prompt when nothing is given), answer it and return it; `waitForPrompt` only waits; `answer` answers a prompt you already have. Nothing answers a prompt by itself: after 0.0.9, `getUserMedia()` waits until the test answers; in 0.0.9, the prompt comes when an app that declares the capability starts, and its window waits. `revoke` takes a decision back and returns whether there was one. See [Approvals in tests](../guide/testing.md#approvals).
- `drop` drops files from the system onto a page (default: the middle of the desktop page; `web` picks a page, `x` and `y` a point in it). The page gets a standard `drop` event a moment after the call returns, so wait for what the page does with it.

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
  focus() / minimize() / restore() / fill() / fullscreen() / close(): Promise<ActResult>

  readonly mouse: Mouse
  readonly keyboard: Keyboard
  readonly clock: Clock

  addInitScript(code: string, options?: { once?: boolean }): Promise<number>
  reload(options?: { timeout?: number }): Promise<void>
  resize(width: number, height: number, options?: { timeout?: number }): Promise<{ width: number; height: number }>
  seedLocalStorage(entries: Record<string, string>, options?: { timeout?: number }): Promise<void>
  answerDialog(answer?: { accept?: boolean; text?: string }): Promise<void>
  dialogs(): Promise<Dialog[]>
  waitForDialog(options?: { type?: 'alert' | 'confirm' | 'prompt'; timeout?: number }): Promise<Dialog>

  route / waitForRequest / waitForConsole / console / network / drop  // as on Acde, scoped to this window
}

interface RoleOptions {
  name?: string | RegExp; exact?: boolean
  checked?: boolean; disabled?: boolean; selected?: boolean
  expanded?: boolean; pressed?: boolean; focused?: boolean; level?: number
}
```

`AppWindow` looks itself up in the window table again on every use, so it keeps working if the window is closed and reopened.

`info()` is the window's row in that table: `ref`, `id`, `app`, `title`, `state` (`normal`, `minimized`, `filled`, `fullscreen`), `focus`, `hidden` and more. While a window is minimized, `state` is `minimized`, `hidden` is `true`, and locators find no element in it: `toBeHidden()` passes, and an action waits until its timeout (`no element matches`). `restore()` brings the window and its elements back. `fill()` fills the desktop's work area with the window and `fullscreen()` covers the whole host window with it (state `filled` / `fullscreen`); `restore()` sets either back to `normal`. Both are refused for the desktop and for a window that already fills the host window (a single-app session).

`reload()` waits until the new page has loaded; `resize()` sets the size of the page without the title bar and waits until `innerWidth` and `innerHeight` have it (a window that fills the screen resizes the host window, which Windows cannot do yet); `seedLocalStorage()` writes the entries before the page's scripts run, by reloading the page once.

```ts
class Mouse {
  move(x: number, y: number, options?: { steps?: number }): Promise<ActResult>
  down(options?: { button?: 'left' | 'right' | 'middle' }): Promise<ActResult>
  up(options?: { button?: 'left' | 'right' | 'middle' }): Promise<ActResult>
  click(x: number, y: number, options?: { button?; clickCount?: number; modifiers?: Modifier[] }): Promise<ActResult>
  dblclick(x: number, y: number, options?: { button?; modifiers?: Modifier[] }): Promise<ActResult>
  wheel(deltaX: number, deltaY: number): Promise<ActResult>
}

class Keyboard {
  down(key: string) / up(key: string): Promise<ActResult>
  press(keys: string): Promise<ActResult>       // "Enter", "Control+a"
  type(text: string): Promise<ActResult>        // key presses; characters without a key are inserted as text
  insertText(text: string): Promise<ActResult>  // as the input method commits it, no key events
}

class Clock {
  install(options?: { time?: number | string | Date }): Promise<ClockState>
  fastForward(duration: number | string) / runFor(duration: number | string): Promise<ClockState>
  pauseAt(time) / setFixedTime(time) / setSystemTime(time): Promise<ClockState>
  resume() / state(): Promise<ClockState>
}

type Modifier = 'Shift' | 'Control' | 'Alt' | 'Meta' | 'ControlOrMeta'
```

Coordinates are CSS pixels of the page, as `getBoundingClientRect()` gives them. `ControlOrMeta` is `Control` on every system. A time is milliseconds since 1970, a `Date` or a date string; a duration is milliseconds, `"mm:ss"` or `"hh:mm:ss"`. `ClockState` is `{ installed, paused, now, performanceNow, fixed, timers }`. `fastForward` fires each timer that is due once, `runFor` fires every timer at its own time; `setFixedTime` makes `Date` stand still while timers go on, `setSystemTime` moves `Date` only.

`close()` waits until the window is gone. Closing the only window of a session that runs a single app ends the session: the call resolves with `ended: true` and a text that says so (see `act` under [Acde](#acde)), and the session takes no more requests. A test has no need to close that window, since its session ends with the test.

## Locator

```ts
class Locator {
  getByRole / getByText / getByLabel / … / locator(...)   // search within this element
  filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp; has?: Locator; hasNot?: Locator }): Locator
  or(other: Locator) / and(other: Locator): Locator
  nth(index: number) / first() / last(): Locator

  count(): Promise<number>
  all(): Promise<Locator[]>
  isVisible(): Promise<boolean>
  textContent(): Promise<string>  // the text inside the element (what toHaveText compares)
  text() / name() / value() / states() / ref() / node(): Promise<...>
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>

  click(options?: { button?: 'left' | 'right'; clickCount?: 1 | 2; modifiers?: Modifier[]; timeout?: number }): Promise<ActResult>
  dblclick(options?: { modifiers?: Modifier[] }) / hover(options?: { modifiers?: Modifier[] }): Promise<ActResult>
  focus() / clear(): Promise<ActResult>
  evaluate<T>(fn: string | ((element, arg) => T), arg?: unknown): Promise<T>
  fill(text: string) / type(text: string) / press(keys: string): Promise<ActResult>
  scroll(dy?: number): Promise<ActResult>
  selectOption(values: string | string[]): Promise<ActResult>
  check() / uncheck() / setChecked(checked: boolean): Promise<void>
  dragTo(target: Locator): Promise<ActResult>
  screenshot(options?: { path?: string; mask?: Locator[] }): Promise<Shot>
}
```

When an action fails (`ok: false`), it is retried until the timeout, then `ActError` is thrown.

`evaluate` calls the function in the page with the element and `arg` (JSON), and returns its JSON result; `fn` may also be the source of such a function.

### Semantic tree limitations

`getByRole`, `getByText` and `getByLabel` search the runtime's semantic tree, not the DOM:

- Elements with `opacity: 0` are not in it, so these locators do not find them.
- `getByText` compares accessible names.

CSS locators (`locator`, `getByTestId`, `getByPlaceholder`, `getByTitle`, `getByAltText`) search the DOM and also match elements that are not rendered; `toBeVisible`, `toBeHidden`, `isVisible()` and `waitFor({ state })` tell the two apart, and actions wait until the element is rendered.

## Png

`Png.decode(bytes)`, `Png.encode(image)`, `Png.diff(actual, expected, {threshold})`: PNG encoding/decoding using only `node:zlib`, plus a pixelmatch-style comparison. The screenshot assertions are built on it. `Png.animate(frames)` joins PNGs of one size (`{ png, ms }` each) into an animated PNG; `Video.start(acde)` records the screen with it (`stop()`, then `write(path)`), which is what `acde test --video` keeps.
