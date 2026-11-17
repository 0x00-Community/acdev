# Coding agents

acdev ships a **skill**: instructions and reference files that teach a coding agent (Claude Code, Codex, Cursor, Gemini CLI, and any other that reads the [Agent Skills](https://agentskills.io) format) how to create, run, inspect, and test acde projects. The skill is part of the acdev archive, so it always describes the acdev you have installed. These docs are generated from the same files.

## Set up with one prompt

Paste this into your agent:

```text
Read https://pkgs.dopame.ai/acde/install.md and follow it to set up acdev on this machine.
```

It installs acdev, installs the skill for the agent, and reports what is ready and what is missing.

## Install the skill yourself

```sh
acdev skills install
```

This links the skill into:

- `~/.agents/skills/acdev`, the directory shared by agents that follow the common convention (Codex, Cline, Zed, Warp, Pi, and others);
- the skills directory of every other agent found on this machine, such as `~/.claude/skills/acdev` for Claude Code or `~/.cursor/skills/acdev` for Cursor.

Each one is a link to the skill inside the acdev install, so upgrading acdev upgrades the skill.

| Command | What it does |
| --- | --- |
| `acdev skills` | Shows where the skill is installed and whether each place is current |
| `acdev skills install` | Installs it for every agent found |
| `acdev skills install --agent claude-code,cursor` | Installs it for these agents, found or not |
| `acdev skills install --dir DIR` | Installs it into `DIR/acde`; for an agent acdev does not know, or a project's own skills directory such as `.agents/skills` |
| `acdev skills install --copy` | Copies instead of linking; for agents that cannot follow links. Run it again after upgrading acdev |
| `acdev skills remove` | Removes it from everywhere it was installed (add `--dir DIR` for a directory you chose), and the skills directories `acdev skills install` created there once they are empty |
| `acdev skills path` | Prints the directory of the skill inside the acdev install |

`acdev skills install` never replaces a directory named `acdev` that is not this skill; it stops and names it.

## Agents without skills

Point the agent at the skill's entry file. For example, in the project's `AGENTS.md`:

```text
This is an acde project. Before working on it, read the file SKILL.md in the directory `acdev skills path` prints.
```

## What the agent can do

With an `acdev dev` session running, the [debugging commands](tools.md) let an agent read the screen as text, click and type, take screenshots, and read the console and network logs; [`acdev test`](testing.md) runs end-to-end tests. The same tools are available over [MCP](mcp.md) for agents that prefer it.
