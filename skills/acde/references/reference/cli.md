# CLI

```text
acde <command> [args]
```

On error, acde prints `acde: <reason>` and exits with code 1. Invalid arguments print the usage.

`acde --version` prints the version of acde. `acde --help`, or `--help` after any command, prints the usage.

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
acde check [dir]
```

Checks the config (id, entry, icon, service modules, framework), or the manifest and entry files of a handwritten package.

### acde build

```text
acde build [dir] [--out DIR]
```

Builds into `DIR` (default `.acde`). A relative `--out` is resolved against the project being built. The manifest of the output is checked again.

### acde install

```text
acde install [dir] [--out DIR]
```

Builds, then installs into `$XDG_DATA_HOME/acde/packages/<id>`. See [Local install](../guide/install.md).

### acde dev

```text
acde dev [dir...] [--out DIR] [--app ID] [--desktop ID|DIR] [--headless]
```

Builds, starts acdert, and rebuilds and reloads on changes. See [acde dev](../guide/dev.md).

## Running sessions

These work with a running `acde dev` session, and all of them accept `--session <pid>`. A `<web>` is one page: a web name from `acde webs`, an app id, or `desktop`; a `<ref>` is an element id from `acde inspect`, such as `w1.12`. See [Debugging](../guide/tools.md).

| Command | Description |
| --- | --- |
| `acde webs` | Lists pages |
| `acde eval <web> <code\|->` | Runs code in a page and prints JSON |
| `acde shot <web> [-o FILE]` | Window screenshot, default `./<web>.png` |
| `acde screen [-o FILE]` | Full-screen screenshot, default `./screen.png` |
| `acde inspect [--window W] [--find TEXT] [--all] [--offscreen]` | The screen as text |
| `acde act <ref> <action> [arg]` | Performs an action on a ref |
| `acde console [--web W] [--level L] [--follow]` | Page logs and errors |
| `acde network [--web W] [--failed] [--follow]` | Page requests |
| `acde mcp [--session PID]` | MCP server over stdio; see [MCP](../guide/mcp.md) |

## Coding agents

```text
acde skills [install|remove|path] [--agent ID,...] [--dir DIR] [--copy]
```

| Command | Description |
| --- | --- |
| `acde skills` | Where the acde skill is installed, and whether each place is current |
| `acde skills install` | Links the skill into `~/.agents/skills` and the skills directory of every agent found |
| `acde skills remove` | Removes it from those places |
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
| `--timeout` | Timeout per test (milliseconds, default 60000) |
| `--bail` | Stop at the first failure |
| `--trace` | Leave a `trace.html` for every test |
| `-u`, `--update-screenshots` | Rewrite screenshot baselines |

See [Testing](../guide/testing.md).
