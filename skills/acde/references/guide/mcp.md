# MCP

`acde mcp` is an [MCP](https://modelcontextprotocol.io) server over stdio. It gives AI agents the [debugging tools](tools.md) and more: an agent can start an `acde dev` session itself, look at the screen, click buttons, read the console, and take screenshots, so it can build and verify your app.

Agents can do all of this with the plain [debugging commands](tools.md) too, which need no setup; the [acde skill](agents.md) teaches them how. Use MCP when your agent works better with tools than with a shell.

## Setup

Claude Code:

```sh
claude mcp add acde -- acde mcp
```

Other clients: the command is `acde mcp`, with no arguments (add `--session <pid>` to pin a particular session).

## Tools

| Tool | What it does |
| --- | --- |
| `doctor` | Checks this machine for `acde dev`, as [`acde doctor`](doctor.md) does; call it first when `start` fails |
| `doctor_fix` | Checks, fixes what acde may fix without asking, and checks again, as `acde doctor --fix` does. The fixes that download, install or stop something it only names: the user runs `acde doctor --fix` in a terminal (it asks), or agrees to `acde doctor --fix --yes`. Its `dir` must be inside the working directory |
| `sessions` | Lists running `acde dev` sessions; can pin one |
| `start` / `stop` / `logs` | Starts its own `acde dev` session (for the project in the working directory by default), stops it, reads its output. After 0.0.9, when an `acde dev` already runs exactly that (the same projects, `desktop`, `app` and `headless`), `start` uses that session and says so (`attached to acde dev <pid>, which already runs …`); `stop` and `logs` do not reach a session started elsewhere. When one runs those projects some other way, `start` fails and names it (`… which is not what start asked for`): pin it with `sessions {use: <pid>}`, or stop it first. `start {force: true}` starts another one anyway |
| `webs` | Lists pages, and the camera or microphone prompts that wait |
| `permissions` / `answer` / `revoke` | Lists the camera and microphone prompts that wait and the decisions made, allows or denies a waiting prompt, takes back a decision; see [Camera and microphone](tools.md#camera-and-microphone) |
| `snapshot` | The screen as text: windows and the elements of the focused window, each with a ref |
| `act` / `run` | Performs one action on a ref / several in sequence, and reports what changed |
| `open` | Opens an app and waits for its window |
| `query` | Finds elements by CSS selector, hidden ones too; the refs work with `act` |
| `wait_for` | Waits for some text to appear (or disappear) |
| `screenshot` | Screenshot of one window or the whole screen |
| `eval` | Runs JS in a page |
| `console` / `network` | The pages' logs and requests |
| `emulate` | Switches light/dark mode and reduced motion |
| `choose_folder` / `choose_files` / `choose_save_file` | Answers the page's next file picker in advance |
| `route` / `unroute` | Fakes responses to the page's requests, or makes them fail |
| `pointer` | Moves the pointer to a screen point, as a real move (hover, screen edges) |
| `clipboard` | Reads and writes the clipboard |
| `input` | Sends raw mouse and keyboard events to a page, at page coordinates; `wait` (`ms`) holds a key or button in between (after 0.0.9) |
| `clock` | Takes over a page's time: installs a fake clock, pauses it, moves it forward |
| `dialog` | Answers the page's next `alert` / `confirm` / `prompt` in advance, and lists the dialogs it showed |
| `resize` | Resizes a window so that its page has the given size |

Which session is used: the pinned one; otherwise the one `start` launched; otherwise one picked by the working directory.

Declared capabilities need no answer; only the camera and the microphone ask the user. In 0.0.9 an app that declares one is asked when it starts, and its window waits for the answer; after 0.0.9 the user is asked the first time a page asks for one, and the page waits for the answer. `webs` lists such a prompt as a line, `recorder waits for approval of microphone: the answer tool allows or denies it`. `answer` takes `allow` (true or false). To allow, it must name the `app` and the `capability` that `permissions` lists, so the call states what is granted; to deny, the `prompt` id or the `app` and `capability` will do, and neither is needed when only one prompt waits. It stands in for the user's own answer, so the tool is marked as an action that needs confirmation: allow only what the user asked for or agreed to.

Closing the only window of a session that runs a single app (`act` with `close` on `w1`) ends that session, by design. The call succeeds and its answer says so, `closed w1; acdert exited with it, so acde dev 4242 ended`. The next call fails and says that the session stopped (`the acde dev started here (pid 4242) stopped; last output: …` for a session `start` ran, `acde dev 4242 stopped; no acde dev is running (…)` for one started elsewhere). Run `start` again to go on. Any other action during which the runtime goes away fails with `acdert closed the connection`; so does a `run` whose steps close that window, since the answer to its steps is lost, so close it with `act`.

`input`, `clock`, `dialog` and `resize` do for an agent what `app.mouse` / `app.keyboard`, `app.clock`, `app.answerDialog` and `app.resize` do in a test; see [Time, dialogs and page setup](testing.md#time-dialogs-and-page-setup). `clock` takes `action` (`install`, `pause_at`, `fast_forward`, `run_for`, `resume`, `set_fixed_time`, `set_system_time`, `state`) with a `time` (an ISO string or milliseconds since 1970) or a `duration` (milliseconds, `"mm:ss"` or `"hh:mm:ss"`). `dialog` without `accept` or `text` only lists.

A page's folder, file or save picker can be answered before the page opens it: call `choose_folder` with a `path` (relative paths resolve against the working directory), or with `cancel: true`, then the `act` that opens the picker. Each answer serves the next picker of that kind. In a session started with `start {headless: true}` there is no picker dialog, so a picker that was not answered first fails and the page sees it as cancelled. `choose_files` takes `paths`, `choose_save_file` a `path`.

```json
{ "name": "choose_folder", "arguments": { "path": "fixtures/project" } }
{ "name": "act", "arguments": { "ref": "w1.4", "action": "click" } }
```

On a machine without a display, call `start` with `headless: true`; `screenshot` and `snapshot` work the same. `eval` with `getComputedStyle` or `getBoundingClientRect` checks styles and layout, as in [Styles and layout](tools.md#styles-and-layout).

In a session with windows, `clipboard` touches **your system clipboard**, so the agent must pass `system: true` explicitly, and the tool is marked as an action that needs confirmation. Headless sessions have their own clipboard.

When the server's stdin closes or it receives a signal, it stops the `acde dev` session that `start` launched.
