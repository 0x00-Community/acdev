# Install

acde is one archive: the CLI, the project templates and the SDK. No npm, no root.

## With a coding agent

Give your agent this prompt:

```text
Read https://pkgs.dopame.ai/acde/install.md and follow it to set up acde on this machine.
```

The page it reads tells it to check for Bun or Node.js, run the installer below, install the acde skill for itself, and report what is ready. See [Coding agents](../guide/agents.md).

## Requirements

acde runs on a JavaScript runtime you already have. Either one works:

- [Bun](https://bun.sh) 1.4 or later
- [Node.js](https://nodejs.org) 22.3 or later

If you have both, acde uses Bun. The install script doesn't install either of them for you.

## macOS / Linux

```sh
curl -fsSL https://pkgs.dopame.ai/acde/install.sh | sh
```

This installs into `~/.acde` (change it with `ACDE_INSTALL`) and adds `~/.acde/bin` to your shell's startup file (zsh, bash, fish, or `.profile`). To leave your startup files alone:

```sh
curl -fsSL https://pkgs.dopame.ai/acde/install.sh | sh -s -- --no-modify-path
```

To install a specific version: `sh -s -- --version 0.1.0`.

## Windows

In PowerShell:

```powershell
irm https://pkgs.dopame.ai/acde/install.ps1 | iex
```

This installs into `%USERPROFILE%\.acde` and adds it to your user `Path`. You can also pass options as environment variables: `ACDE_VERSION`, `ACDE_NO_MODIFY_PATH`.

## Verify

Open a new terminal and run:

```sh
acde
```

If it prints usage, acde is installed.

## The runtime

`acde new`, `acde check` and `acde build` need nothing else. `acde dev` and `acde test` run your app in the runtime, acdert, which is **not** part of acde: it comes with the Dopame virtual machine, where `acdert` is already on PATH.

acde looks for the runtime in this order:

1. `ACDERT`: the path of an acdert binary, or the name of one on PATH;
2. `acdert` on PATH.

When neither is there, `acde dev` stops and says so.

The runtime renders pages only on the GPU, so it needs a working GPU (Metal on macOS, DirectX 12 on Windows, Vulkan on Linux). What it can do differs somewhat between platforms; see [Platforms](../reference/platforms.md).

## Upgrade and uninstall

To upgrade, run the install command again. Each version is installed in `~/.acde/versions/<version>`, and `~/.acde/current` points to the one in use.

To uninstall, run `acde skills remove` if you installed the skill, delete `~/.acde`, and remove the line that was added to your shell's startup file.
