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
- Headless by default (`--headed` to watch in a window), with a 60-second timeout per test (`--timeout`). Headless still needs a GPU, so Linux CI machines without one can't run tests; see [Platform support](../reference/platforms.md).

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

## Failures

A failed test leaves these in `.acde/test-results/<file>/<test>/`:

`error.txt` `output.log` `screen.png` `snapshot.txt` `console.txt` `network.txt` `trace.txt`

With `--trace`, every test leaves a `trace.html`: each action and assertion, with its duration and result, and a full-screen screenshot after each step.

## Commands

```sh
acde test                        # all *.e2e.* in the project
acde test e2e/tasks.e2e.ts       # specific files
acde test -t "adds"              # filter by name
acde test --headed               # watch in a window
acde test --desktop dopame       # run the app in the dopame desktop
acde test --bail --timeout 30000
acde test --trace
acde test -u                     # update screenshot baselines
```

## Editor types

`acde test` resolves `acde/test` on its own at run time, but your editor does not know where it is. For now, add `paths` to the project's `tsconfig.json` pointing into the install directory (for example `~/.acde/current/lib/acde/dist/types/e2e/index.d.ts`); a separate types package will follow.

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
