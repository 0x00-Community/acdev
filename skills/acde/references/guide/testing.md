# Testing

`acde test` tests your app in the real runtime: each test gets a fresh, isolated `acde dev` session, and a Playwright-like API finds elements, clicks, types, asserts, and compares screenshots. Requires Bun, even when the project itself runs on Node.js.

## A first test

Test files are named `*.e2e.ts` (or `.tsx`, `.js`, `.mjs`, `.mts`) and can live anywhere in the project:

```ts
// e2e/tasks.e2e.ts
import { test, expect } from 'acde/test'

test('adds a task', async ({ app }) => {
  await app!.getByRole('textbox', { name: 'New task' }).fill('Buy milk')
  await app!.getByRole('button', { name: 'Add' }).click()
  await expect(app!.getByRole('listitem')).toHaveCount(1)
})

test('starts empty again', async ({ app }) => {
  await expect(app!.getByRole('listitem')).toHaveCount(0)
})
```

```sh
acde test
```

Plain `bun test` does not match `*.e2e.*`, so unit tests and end-to-end tests stay out of each other's way. `acde test` resolves `acde/test` and `acde/driver` to the acde that is running it, so the project does not need to install anything.

## Fixtures

The test function receives:

| Name | What it is |
| --- | --- |
| `app` | For an app project, its window (`AppWindow`); for a desktop project, `null` |
| `acde` | The whole session (`Acde`): open apps, take screenshots, emulate, fake requests, and more |
| `home` | This test's temporary `HOME` |
| `settings` | The settings for this run |

## Isolation

Each test gets:

- Temporary `HOME` and `XDG_*` directories, and in-memory storage only;
- A 1280 × 800 screen, light mode, reduced motion, and no autostart items;
- Headless by default (`--headed` to watch in a window), with a 60-second timeout per test (`--timeout`); the time the session takes to start counts. Headless still needs a GPU, so Linux CI machines without one can't run tests; see [Platform support](../reference/platforms.md).

Builds go into `.acde/test`, results into `.acde/test-results`.

## Locators

The same locators as Playwright, matched against the **semantic tree** (the accessibility tree):

```ts
app.getByRole('button', { name: 'Save' })
app.getByText('Saved')
app.getByLabel('Email')
app.getByPlaceholder('Search')
app.getByTitle('Close')
app.getByAltText('Avatar')
app.getByTestId('submit')          // data-testid
app.locator('ul.tasks > li')       // CSS selector
app.getByRole('listitem').filter({ hasText: 'Milk' }).first()
```

Locators are lazy: they are resolved again against the latest tree every time they are used. Actions require **exactly one** match; with several, they fail instead of guessing.

## Actions

```ts
await locator.click()
await locator.dblclick()
await locator.hover()
await locator.fill('text')       // replaces
await locator.type('text')       // appends
await locator.clear()
await locator.press('ctrl+a backspace') // key names: see Tools, "Key names"
await locator.selectOption('beta')
await locator.check() / uncheck() / setChecked(true)
await locator.dragTo(other)
await locator.scroll(400)
```

`click`, `fill`, and similar actions wait for the element to be enabled (not `disabled`), and retry until the timeout when they fail.

## Assertions

```ts
await expect(locator).toBeVisible()
await expect(locator).toHaveText('Done')
await expect(locator).toContainText('Done')
await expect(locator).toHaveValue('42')
await expect(locator).toHaveCount(3)
await expect(locator).toBeChecked()
await expect(locator).toBeDisabled()
await expect(locator).toBeFocused()
await expect(locator).toHaveAttribute('aria-expanded', 'true')
await expect(locator).not.toBeVisible()

await expect(app).toHaveTitle('Notes')
await expect(app).toBeOpen()
```

`toHaveText` and `toContainText` compare the element's text content, as in Playwright: the text inside it, whitespace collapsed, not its accessible name. An `<output aria-label="Display">18</output>` has the text `18`; locators such as `getByText` and `getByRole(…, { name })` match the accessible name (`Display`). `locator.textContent()` reads the text content, `locator.name()` the accessible name.

UI assertions retry until the timeout (5 seconds by default). `expect` on any other value is the `expect` from `bun:test`.

## Screenshots

```ts
await expect(app).toHaveScreenshot()
await expect(app.getByRole('textbox')).toHaveScreenshot('field', { maxDiffPixels: 20, mask: [app.getByTestId('clock')] })
```

- Baselines live next to the test file in `__screenshots__/<file name>/<name>-<platform>.png`. If there is no baseline, one is written; if the `CI` environment variable is set, that is an error instead.
- Screenshots are taken until two in a row are identical, and only then compared; on a mismatch, it keeps retaking until the timeout.
- On failure, three images, `-actual`, `-expected`, and `-diff`, are written to the results directory.
- `acde test -u` rewrites the baselines.
- Options: `maxDiffPixels`, `maxDiffPixelRatio`, `threshold` (default 0.2), `mask`, `timeout`.

## Network, file pickers, clipboard

```ts
// Fake responses
await app.route('/api/todos', { json: [{ id: 1, title: 'mocked' }] })
await app.route('**/avatar.png', { abort: true })

// Wait for a request or a log entry (call first, then trigger)
const request = app.waitForRequest('/api/save', { method: 'POST' })
await app.getByRole('button', { name: 'Save' }).click()
await request

// Answer file pickers in advance
await acde.chooseFiles(['/tmp/a.txt'])
await acde.chooseFolder('/tmp/project')
await acde.chooseSaveFile('/tmp/out.md')

// Dark mode
await acde.emulate({ colorScheme: 'dark' })

// Clipboard (headless sessions have their own)
await acde.setClipboard('hello')
```

## Approvals

Some capabilities need the user's approval before the app gets them (see [Capabilities](capabilities.md#approval)). Every test starts with an empty home, so nothing is approved yet, and no prompt is answered by itself: an app that requires such a capability opens no window until the test answers. Answer first, then use `app`:

```ts
import { expect, test } from 'acde/test'

test('the app gets Downloads once the user allows it', async ({ app, acde }) => {
  await acde.allow({ capability: 'fs.downloads' })
  const roots = await app!.evaluate<{ id: string }[]>(`import('acde:fs').then((m) => m.fs.roots())`)
  expect(roots.map((root) => root.id)).toEqual(['private', 'downloads'])
})
```

`acde.allow()` and `acde.deny()` wait for a matching prompt (`{ app, capability }`, both optional) and answer it; `acde.permissions()` lists what waits and what was decided; `acde.revoke(app, capability)` takes a decision back. To test how the app behaves when the user says no, make the capability optional in the config and `deny` the prompt that `request()` raises; denying a required capability means the app does not start.

## Failures

A failed test leaves these in `.acde/test-results/<file>/<test>/`:

`error.txt` `output.log` `screen.png` `snapshot.txt` `console.txt` `network.txt` `trace.txt`

A test that runs out of time fails with `TimeoutError: the test did not finish within <ms> ms (its timeout: --timeout, or the one given to test())` and leaves the same files, taken at that moment.

A test whose session does not start has no screen to save: it leaves `error.txt` and `output.log`, the whole output of that test's `acde dev`. The error says how far the start got, then quotes the last 40 lines of that output (an app that cannot start says why there, for example `Notes needs "clock" (service not running)`):

| The error starts with | What happened |
| --- | --- |
| `acde dev exited (<code>) before it was ready:` | `acde dev` ended with that exit code: the build failed, or acdert refused the app |
| `acde dev (pid <pid>) did not register a session within <n> s in <dir>`, then `no session yet: its build did not finish, or acdert did not start listening; last output:` | The build or the start of acdert took longer than the test's timeout allows |
| `acde dev did not start within <n> s:`, then `acdert runs and answers, but no window appeared (pages: 0, windows: 0) and no approval prompt waits; last output:` | acdert runs, but the app opened no window |

With `--trace`, every test leaves a `trace.html`: each action and assertion, with its duration and result, and a full-screen screenshot after each step.

## Commands

```sh
acde test                        # all *.e2e.* in the project
acde test e2e/tasks.e2e.ts       # specific files
acde test -t "adds"              # only tests whose names match this regular expression
acde test --headed               # watch in a window
acde test --desktop dopame       # run the app in the dopame desktop
acde test --bail --timeout 30000
acde test --trace
acde test -u                     # update screenshot baselines
```

With `-t`, a file in which no test matches is skipped and does not count as failed (`acde test: e2e/approval.e2e.ts: no test matches -t "saves", skipped`); if no test matches in any file, `acde test` prints `acde test: no test matches -t "<pattern>" in <n> files` and exits with code 1.

Each file prints the output of its own `bun test` run as it goes. The run ends with two summary lines, one that counts tests and one that counts files:

```text
acde test: 5 tests ran: 4 passed, 1 failed, 1 not run (skipped, todo, or not matched by -t)
acde test: 2 files, 1 passed, 1 failed: e2e/notes.e2e.ts
  what the failing tests left: /path/to/notes/.acde/test-results
```

- The first line counts the tests of the files that ran: how many ran, passed and failed, and, when there are any, how many did not run (`test.skip`, `test.todo`, and tests that `-t` left out). The numbers come from the report `bun test` writes for each file. A file that left no report (it failed to load, or its run was killed) is named instead of counted: `; not counted: e2e/broken.e2e.ts (bun test left no report: the file did not load, or its run was killed)`.
- The second line counts the files that ran, **not tests**: a file passes when all its tests did. It names the files that failed, and adds `, <n> skipped (no test matches -t)` and `, <n> not run (--bail)` when that applies. The indented line under it appears when a failing test left files.

The exit code is 0 when nothing failed and 1 otherwise.

## Editor types

`acde/test` exports the types of everything it hands you, so helpers can be typed: `Fixtures` (the test body's argument), `AppWindow` (the `app` fixture), `Locator`, `Acde`, and the option and result types listed in the [Testing API](../reference/testing.md).

```ts
import { test, expect, type AppWindow, type Locator } from 'acde/test'

async function enter(app: AppWindow, keys: string[]): Promise<Locator> {
  for (const key of keys) await app.getByRole('button', { name: key }).click()
  return app.locator('#display')
}

test('adds', async ({ app }) => {
  await expect(await enter(app!, ['1', '+', '2', '='])).toHaveText('3')
})
```

`acde test` resolves `acde/test` on its own at run time, but your editor does not know where it is. For now, add `paths` to the project's `tsconfig.json` pointing at the type declarations in the install directory, with the absolute path of your home directory (`tsconfig.json` does not expand `~` or `%USERPROFILE%`):

```jsonc
{
  "compilerOptions": {
    "skipLibCheck": true,
    "paths": {
      "acde/test": ["/home/me/.acde/current/lib/acde/dist/types/e2e/index.d.ts"],
      "acde/driver": ["/home/me/.acde/current/lib/acde/dist/types/driver/index.d.ts"]
      // Windows: "C:/Users/me/.acde/current/lib/acde/dist/types/e2e/index.d.ts"
    }
  }
}
```

`acde test` reads the same `paths` and replaces these two entries with its own, so they do not change how tests run. A separate types package will follow.

## The driver alone

`acde/driver` also works in any Node.js or Bun script:

```ts
import { Acde } from 'acde/driver'

const acde = await Acde.launch({ dirs: ['./my-app'], headless: true })
await acde.open('notes')
await acde.window('notes').getByRole('button', { name: 'New' }).click()
await acde.close()
```

`Acde.attach()` connects to an `acde dev` session that is already running. For the full API, see [Reference: Testing API](../reference/testing.md).
