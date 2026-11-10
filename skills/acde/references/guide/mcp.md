# MCP

`acde mcp` is an [MCP](https://modelcontextprotocol.io) server over stdio. It gives AI agents the [debugging tools](tools.md) and more: an agent can start `acde dev` itself, look at the screen, click buttons, read the console, and take screenshots, so it can build and verify your app.

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
| `start` / `stop` / `logs` | Starts its own `acde dev` (for the project in the working directory by default), stops it, reads its output |
| `webs` | Lists pages |
| `snapshot` | The screen as text: windows and the elements of the focused window, each with a ref |
| `act` / `run` | Performs one action on a ref / several in sequence, and reports what changed |
| `open` | Opens an app and waits for its window |
| `query` | Finds elements by CSS selector |
| `wait_for` | Waits for some text to appear (or disappear) |
| `screenshot` | Screenshot of one window or the whole screen |
| `eval` | Runs JS in a page |
| `console` / `network` | The pages' logs and requests |
| `emulate` | Switches light/dark mode and reduced motion |
| `choose_folder` / `choose_files` / `choose_save_file` | Answers the page's next file chooser in advance |
| `route` / `unroute` | Fakes responses to the page's requests, or makes them fail |
| `clipboard` | Reads and writes the clipboard |

Which session is used: the pinned one; otherwise the one `start` launched; otherwise one picked by the working directory.

In a session with windows, `clipboard` touches **your system clipboard**, so the agent must pass `system: true` explicitly, and the tool is marked as an action that needs confirmation. Headless sessions have their own clipboard.

When the server's stdin closes or it receives a signal, it stops the `acde dev` that `start` launched.
