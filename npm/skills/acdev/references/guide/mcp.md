# MCP

`acdev mcp` is an [MCP](https://modelcontextprotocol.io) server over stdio. It gives AI agents the [debugging tools](tools.md) and more: an agent can start an `acdev dev` session itself, look at the screen, click buttons, read the console, and take screenshots, so it can build and verify your app.

Agents can do all of this with the plain [debugging commands](tools.md) too, which need no setup; the [acdev skill](agents.md) teaches them how. Use MCP when your agent works better with tools than with a shell.

## Setup

Claude Code:

```sh
claude mcp add acdev -- acdev mcp
```

Other clients: the command is `acdev mcp`, with no arguments (add `--session <pid>` to pin a particular session).

## Tools

| Tool | What it does |
| --- | --- |
| `doctor` | Checks this machine for `acdev dev`, as [`acdev doctor`](doctor.md) does; call it first when `start` fails |
| `doctor_fix` | Checks, fixes what acdev may fix without asking, and checks again, as `acdev doctor --fix` does. The fixes that download, install or stop something it only names: the user runs `acdev doctor --fix` in a terminal (it asks), or agrees to `acdev doctor --fix --yes`. Its `dir` must be inside the working directory |
| `sessions` | Lists running `acdev dev` sessions; can pin one |
| `start` / `stop` / `logs` | Starts its own `acdev dev` session (for the project in the working directory by default), stops it, reads its output. When an `acdev dev` already runs exactly that (the same projects, `desktop`, `app` and `headless`), `start` uses that session and says so (`attached to acdev dev <pid>, which already runs …`); `stop` and `logs` do not reach a session started elsewhere. When one runs those projects some other way, `start` fails and names it (`… which is not what start asked for`): pin it with `sessions {use: <pid>}`, or stop it first. `start {force: true}` starts another one anyway |
| `webs` | Lists pages, and the camera or microphone prompts that wait |
| `permissions` / `answer` / `revoke` | Lists the camera and microphone prompts that wait and the decisions made, allows or denies a waiting prompt, takes back a decision; see [Camera and microphone](tools.md#camera-and-microphone) |
| `snapshot` | The screen as text: windows and the elements of the focused window, each with a ref |
| `act` / `run` | Performs one action on a ref / several in sequence, and reports what changed; a window ref also takes `move` (arg `"x,y"`), `resize` (arg `"WxH"`) and `raise` |
| `open` | Opens an app and waits for its window; with `path` (a file or folder) or `url` (http, https) opens that with its default app or `app`, as `acde:open` does |
| `query` | Finds elements by CSS selector, hidden ones too; the refs work with `act` |
| `wait_for` | Waits for some text to appear (or disappear) |
| `screenshot` | Screenshot of one window or the whole screen; the desktop's panels (Dock, menu bar) only on the whole screen. `ref` keeps only one element or window (cut from the screen, or from `target` when that is its window); `rect` `[x, y, width, height]` only an area in logical pixels of the window, or of the screen with `target: "screen"` |
| `eval` | Runs JS in a page |
| `console` / `network` | The pages' logs and requests; in a guest session without `web` every page process (sandboxed apps too) merged in time order, and `next` is an object of one cursor per process, passed back as `since` |
| `emulate` | Switches light/dark mode |
| `appearance` | Shows or sets dark or light (`scheme`), the glass level (`glassLevel` 0 clear, 1 medium, 2 tinted) and reduced transparency; in the guest session it is the system setting, in a host session only this session |
| `choose_folder` / `choose_files` / `choose_save_file` | Answers the page's next file picker in advance |
| `route` / `unroute` | Fakes responses to the page's requests, or makes them fail |
| `pointer` | Moves the pointer to a screen point, as a real move (hover, screen edges) |
| `clipboard` | Reads and writes the clipboard |
| `call` | In a guest session (`--session vm`), calls the session manager (`manager`) or the Dopame backend (`desktop`) and answers the result as JSON; each side refuses what it does not let through, see [call](tools.md#call) |
| `approvals` | In a guest session, lists the system confirms that wait, or with `show` puts one on the screen; answer it with `act` on the confirm window, see [System confirms](tools.md#system-confirms) |
| `input` | Sends raw mouse and keyboard events to a page, at page coordinates; `wait` (`ms`) holds a key or button in between |
| `clock` | Takes over a page's time: installs a fake clock, pauses it, moves it forward |
| `dialog` | Answers the page's next `alert` / `confirm` / `prompt` in advance, and lists the dialogs it showed |
| `resize` | Resizes a window so that its page has the given size |
| `wait` | Waits until a condition holds, with the conditions of [acdev wait](tools.md#waiting): `condition` plus `web`, `app`, `window`, `match`, `text`, `code`, `name`, `ref`, `selector`, `quiet`, `focused`, `gone`, `timeout_ms`; answers with the value it ended on as JSON, and past the timeout fails with the last value |
| `hit` | What lies under a screen point (`x`, `y`), as [acdev hit](tools.md#hit-and-render); `json` for the whole answer |
| `render` | The path each page draws on (`web` or `window` for one page), as [acdev render](tools.md#hit-and-render); `json` for the whole answer |
| `evidence` | Keeps the screen, webs, element tree, console, network and, in a guest session, the journal in a new folder, as [acdev evidence](tools.md#evidence) (`label`, `since`, `output`) |
| `explain` | In a guest session started by acdev, why the system agent decided the audit record `id` as it did, as [acdev explain](tools.md#explain) |
| `timeline` | One time-ordered list of the guest journal, the pages' console and network and acdev's own steps, as [acdev timeline](tools.md#timeline) (`since`, `until`, `source`, `kind`, `window`, `json`) |

Which session is used: the pinned one; otherwise the one `start` launched; otherwise one picked by the working directory.

Declared capabilities need no answer; only the camera, the microphone and idle detection (`idleDetection`) ask the user. The user is asked the first time a page asks for one, and the page waits for the answer. `webs` lists such a prompt as a line, `recorder waits for approval of microphone: the answer tool allows or denies it`. `answer` takes `allow` (true or false). To allow, it must name the `app` and the `capability` that `permissions` lists, so the call states what is granted; to deny, the `prompt` id or the `app` and `capability` will do, and neither is needed when only one prompt waits. It stands in for the user's own answer, so the tool is marked as an action that needs confirmation: allow only what the user asked for or agreed to.

Closing the only window of a session that runs a single app (`act` with `close` on `w1`) ends that session, by design. The call succeeds and its answer says so, `closed w1; acdev runtime exited with it, so acdev dev 4242 ended`. The next call fails and says that the session stopped (`the acdev dev started here (pid 4242) stopped; last output: …` for a session `start` ran, `acdev dev 4242 stopped; no acdev dev is running (…)` for one started elsewhere). Run `start` again to go on. Any other action during which the runtime goes away fails with `acdev runtime closed the connection`; so does a `run` whose steps close that window, since the answer to its steps is lost, so close it with `act`.

`input`, `clock`, `dialog` and `resize` do for an agent what `app.mouse` / `app.keyboard`, `app.clock`, `app.answerDialog` and `app.resize` do in a test; see [Time, dialogs and page setup](testing.md#time-dialogs-and-page-setup). `clock` takes `action` (`install`, `pause_at`, `fast_forward`, `run_for`, `resume`, `set_fixed_time`, `set_system_time`, `state`) with a `time` (an ISO string or milliseconds since 1970) or a `duration` (milliseconds, `"mm:ss"` or `"hh:mm:ss"`). `dialog` without `accept` or `text` only lists.

A page's folder, file or save picker can be answered before the page opens it: call `choose_folder` with a `path` (relative paths resolve against the working directory), or with `cancel: true`, then the `act` that opens the picker. Each answer serves the next picker of that kind. In a session started with `start {headless: true}` there is no picker dialog, so a picker that was not answered first fails and the page sees it as cancelled. `choose_files` takes `paths`, `choose_save_file` a `path`.

```json
{ "name": "choose_folder", "arguments": { "path": "fixtures/project" } }
{ "name": "act", "arguments": { "ref": "w1.4", "action": "click" } }
```

On a machine without a display, call `start` with `headless: true`; `screenshot` and `snapshot` work the same. `eval` with `getComputedStyle` or `getBoundingClientRect` checks styles and layout, as in [Styles and layout](tools.md#styles-and-layout).

In a session with windows, `clipboard` touches **your system clipboard**, so the agent must pass `system: true` explicitly, and the tool is marked as an action that needs confirmation. Headless sessions have their own clipboard.

When the server's stdin closes or it receives a signal, it stops the `acdev dev` session that `start` launched.
