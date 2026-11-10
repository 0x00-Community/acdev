# CLI

```text
acde <command> [args]
```

On error, acde prints one line, `acde: <reason>`, and exits with code 1. A wrong argument (an action `act` does not know, a level `console` does not know, …) is answered with one line that names what is wrong and the `acde <command> --help` to read, such as `acde: console: --level loud: one of log, info, warn, error, debug, errors (acde console --help)`; the full usage is printed only by `acde` with no command.

`acde --version` (or `-v`) prints the version of acde on the first line, then the SDK version and contract level it was built with, and the acdert it finds (`ACDERT`, the one installed next to acde, then PATH) with that runtime's version and contract level. `acde --help` (or `-h`) prints the usage; `acde <command> --help` and `acde help <command>` print that command only. An unknown command or argument prints one line that says what is wrong and which `--help` to read, and exits with code 1. Color follows `NO_COLOR`.

## Projects

### acde new

```text
acde new [dir] [--template T] [--id ID] [--label NAME] [--backend] [--install] [--git] [--pm PM] [--yes]
```

Creates a project. In a terminal, it asks for whatever is missing; with `--yes`, or outside a terminal, it asks nothing (then `dir` is required, the template defaults to `html`, and no dependencies are installed and no repository is created).

| Option | Description |
| --- | --- |
| `--template` | `html` `desktop` `react` `vue` `svelte` `solid` `preact` `vanilla` `next` `nuxt` `sveltekit` `astro` |
| `--id` / `--label` | App id and display name |
| `--backend` | Include a backend (`html` only) |
| `--install` | Install dependencies |
| `--git` | `git init` and make the first commit (if a git user name and email are configured) |
| `--pm` | `bun` `npm` `pnpm` `yarn`; decides whether the project runs on Bun or Node.js |

### acde check

```text
acde check [dir] [--platform windows|macos|linux]
```

Checks the config (id, entry, icon, service modules, framework) and the manifest rules of the SDK, or the manifest and entry files of a handwritten package, and the `acde:` imports against the manifest.

`--platform` adds a check of the app's declared capabilities against what that platform has, once for each way of running an app there (`desktop` and `standalone`, on Linux also `session`):

- A required capability that the platform lacks is an error: `error: windows (desktop): app "notes" requires network, which this mode lacks`.
- An optional capability that it lacks is a note, and no error: `note: windows (desktop): app "notes" runs without optional camera, which this mode lacks`.
- When no required capability is missing, the last line is `ok: linux (session, desktop, standalone): every required capability is there`.

### acde build

```text
acde build [dir] [--out DIR]
```

Builds into `DIR` (default `.acde`). A relative `--out` is resolved against the project being built. The manifest of the output is checked again.

### acde install

```text
acde install [dir] [--out DIR]
```

Builds, then installs into `$XDG_DATA_HOME/acde/packages/<id>`; without `XDG_DATA_HOME`, `~/.local/share/acde/packages/<id>` (on Windows `%USERPROFILE%\.local\share\acde\packages\<id>`). See [Local install](../guide/install.md).

### acde dev

```text
acde dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless]
```

Builds, starts acdert, and rebuilds and reloads on changes. See [acde dev](../guide/dev.md).

## Running sessions

These work with a running `acde dev` session, and all of them accept `--session <pid>`. A `<web>` is one page: a web name from `acde webs`, an app id, or `desktop`; a `<ref>` is an element id from `acde inspect` or `acde query`, such as `w1.12`, or a window, such as `w1`. See [Debugging](../guide/tools.md).

| Command | Description |
| --- | --- |
| `acde webs` | Lists pages |
| `acde eval <web> <code\|->` | Runs code in a page and prints JSON |
| `acde shot <web> [-o FILE]` | Window screenshot, default `./<web>.png` |
| `acde screen [-o FILE]` | Full-screen screenshot, default `./screen.png` |
| `acde inspect [--window W] [--find TEXT] [--all] [--offscreen]` | The screen as text |
| `acde query <selector> [--window W] [--ref REF] [--limit N]` | The elements a CSS selector matches, each with a ref |
| `acde act <ref> <action> [arg]` | Performs an action on a ref |
| `acde console [--web W] [--level L] [--since S] [--follow]` | Page logs and errors; `--since reload` or `--since N` |
| `acde network [--web W] [--failed] [--since S] [--follow]` | Page requests; `--since reload` or `--since N` |
| `acde permissions` | The approval prompts that wait and the decisions made |
| `acde allow [<prompt id> \| <app> <capability>] [--all]` | Allows a waiting approval prompt |
| `acde deny [<prompt id> \| <app> <capability>] [--all]` | Denies a waiting approval prompt |
| `acde revoke <app> <capability>` | Takes back a decision |
| `acde stop` | Ends the session and its acdert; see [Stopping](../guide/dev.md#stopping) |
| `acde mcp [--session PID]` | MCP server over stdio; see [MCP](../guide/mcp.md) |

| Option | Description |
| --- | --- |
| `--window` | `inspect`, `query`: this window (`w1`) instead of the focused one |
| `--ref` | `query`: search only under this element (`w1.12`) |
| `--limit` | `query`: list at most this many elements (1 to 3000, default 600) |
| `--all` | `inspect`: every window that is not marked `[minimized]`, and elements hidden by `opacity: 0` or `visibility`. `allow`, `deny`: every waiting prompt |

`acde query` prints `N in <window>:` and one line per element, or `nothing in <window> matches "<selector>"`; both exit with code 0. `acde act` prints what it did and what changed, and exits with code 1 when the action was not done (the reason is then the only line).

`acde permissions` prints two blocks and exits with code 0:

```text
pending:
  2  notes  fs.documents  (launch)
decisions:
  notes  fs.downloads  granted
```

A pending line is `<prompt id>  <app>  <capability>  (<reason>)`, where the reason is `launch` (asked before the app starts) or `request` (asked by the running app); a decision line is `<app>  <capability>  <granted|denied>`. An empty block is `pending: none` or `decisions: none`.

`acde allow` and `acde deny` answer prompts that wait now. Without arguments they answer the only waiting prompt; when several wait they answer none, list them, and exit with code 1. `<prompt id>` names one prompt, `<app> <capability>` the prompt of that app for that capability, and `--all` every waiting prompt. Each answered prompt prints `allowed <app> <capability> (prompt <id>)` or `denied <app> <capability> (prompt <id>)`. When nothing waits, or nothing matches, they print one line that says so (`acde: no approval prompt is waiting`, `acde: no approval prompt 5 is waiting (waiting: 2)`) and exit with code 1.

`acde revoke <app> <capability>` prints `revoked <app> <capability>`; when there is no such decision it says so and exits with code 1.

When no page runs because an app waits for an approval, `acde webs` prints, after the empty table, one line per prompt: `<app> waits for approval of <capability>: acde allow (or acde deny)`. See [Approvals](../guide/tools.md#approvals).

## Coding agents

```text
acde skills [install|remove|path] [--agent ID,...] [--dir DIR] [--copy]
```

| Command | Description |
| --- | --- |
| `acde skills` | Where the acde skill is installed, and whether each place is current |
| `acde skills install` | Links the skill into `~/.agents/skills` and the skills directory of every agent found |
| `acde skills remove` | Removes it from those places, and the directories `install` created that are now empty |
| `acde skills path` | Prints the skill's directory inside the acde install |

| Option | Description |
| --- | --- |
| `--agent` | These agents (comma-separated ids such as `claude-code`, `codex`, `cursor`) instead of the ones found |
| `--dir` | This skills directory instead; the skill goes into `DIR/acde` |
| `--copy` | Copy instead of link (`install` only) |

See [Coding agents](../guide/agents.md).

## Testing

```text
acde test [dir|file...] [--headed] [-t PATTERN] [--desktop ID|DIR] [--timeout MS] [--bail] [--trace] [-u]
```

| Option | Description |
| --- | --- |
| `--headed` | Open windows (headless by default) |
| `-t`, `--test-name-pattern` | Run only tests whose names match |
| `--desktop` | Run the app in this desktop |
| `--timeout` | Timeout per test, including the start of its session (milliseconds, default 60000) |
| `--bail` | Stop at the first failure |
| `--trace` | Leave a `trace.html` for every test |
| `-u`, `--update-screenshots` | Rewrite screenshot baselines |

The run ends with a line that counts tests (`acde test: 5 tests ran: 4 passed, 1 failed`) and a last line that counts files (`acde test: 2 files, 1 passed, 1 failed: e2e/notes.e2e.ts`); see [Testing](../guide/testing.md#commands).
