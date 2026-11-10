# Coding agents

acde ships a **skill**: instructions and reference files that teach a coding agent (Claude Code, Codex, Cursor, Gemini CLI, and any other that reads the [Agent Skills](https://agentskills.io) format) how to create, run, inspect and test acde projects. The skill is part of the acde archive, so it always describes the acde you have installed. These docs are generated from the same files.

## Set up with one prompt

Paste this into your agent:

```text
Read https://pkgs.dopame.ai/acde/install.md and follow it to set up acde on this machine.
```

It installs acde, installs the skill for the agent, and reports what is ready and what is missing.

## Install the skill yourself

```sh
acde skills install
```

This links the skill into:

- `~/.agents/skills/acde`, the directory shared by agents that follow the common convention (Codex, Cline, Zed, Warp, Pi, and others);
- the skills directory of every other agent found on this machine, such as `~/.claude/skills/acde` for Claude Code or `~/.cursor/skills/acde` for Cursor.

Each one is a link to the skill inside the acde install, so upgrading acde upgrades the skill.

| Command | What it does |
| --- | --- |
| `acde skills` | Shows where the skill is installed and whether each place is current |
| `acde skills install` | Installs it for every agent found |
| `acde skills install --agent claude-code,cursor` | Installs it for these agents, found or not |
| `acde skills install --dir DIR` | Installs it into `DIR/acde`; for an agent acde does not know, or a project's own skills directory such as `.agents/skills` |
| `acde skills install --copy` | Copies instead of linking; for agents that cannot follow links. Run it again after upgrading acde |
| `acde skills remove` | Removes it from everywhere it was installed (add `--dir DIR` for a directory you chose) |
| `acde skills path` | Prints the directory of the skill inside the acde install |

`acde skills install` never replaces a directory named `acde` that is not this skill; it stops and names it.

## Agents without skills

Point the agent at the skill's entry file. For example, in the project's `AGENTS.md`:

```text
This is an acde project. Before working on it, read the file SKILL.md in the directory `acde skills path` prints.
```

## What the agent can do

With `acde dev` running, the [debugging commands](tools.md) let an agent read the screen as text, click and type, take screenshots, and read the console and network logs; [`acde test`](testing.md) runs end-to-end tests. The same tools are available over [MCP](mcp.md) for agents that prefer it.
