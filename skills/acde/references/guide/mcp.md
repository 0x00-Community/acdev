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
| `sessions` | Lists running `acde dev` sessions; can pin one |
| `start` / `stop` / `logs` | Starts its own `acde dev` session (for the project in the working directory by default), stops it, reads its output |
| `webs` | Lists pages; when an app waits for an approval instead, says so |
| `permissions` / `answer` / `revoke` | Lists the approval prompts that wait and the decisions made, allows or denies a waiting prompt, takes back a decision; see [Approvals](tools.md#approvals) |
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
| `clipboard` | Reads and writes the clipboard |

Which session is used: the pinned one; otherwise the one `start` launched; otherwise one picked by the working directory.

An app that requires a capability the user must approve opens no window until its prompt is answered. `start` and `webs` then answer an empty table and a line per prompt, `notes waits for approval of fs.downloads: the answer tool allows or denies it`. `answer` takes `allow` (true or false). To allow, it must name the `app` and the `capability` that `permissions` lists, so the call states what is granted; to deny, the `prompt` id or the `app` and `capability` will do, and neither is needed when only one prompt waits. It stands in for the user's own answer, so the tool is marked as an action that needs confirmation: allow only what the user asked for or agreed to.

Closing the only window of a session that runs a single app (`act` with `close` on `w1`) ends that session: the tool answers `acdert closed the connection`, and the next call says that the session stopped. Run `start` again to go on.

In a session with windows, `clipboard` touches **your system clipboard**, so the agent must pass `system: true` explicitly, and the tool is marked as an action that needs confirmation. Headless sessions have their own clipboard.

When the server's stdin closes or it receives a signal, it stops the `acde dev` session that `start` launched.
