# Install

The installer sets up acde (the CLI, the project templates, and the SDK) together with the runtime it pairs with, acdert, which runs your apps. No npm, no root. See [The runtime](#the-runtime).

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

`acde test` (end-to-end tests) runs on Bun only. With only Node.js, every other command works.

## Supported platforms

| System | CPU |
| --- | --- |
| macOS | Apple silicon (arm64), Intel (x86_64) |
| Linux | x86_64 |
| Windows | x64 |

acde itself is JavaScript; these are the platforms the runtime is built for (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`), and the installer stops with this list on any other. The Windows installer is x64 only. What the runtime can do differs somewhat between them; see [Platform support](../reference/platforms.md).

## macOS / Linux

```sh
curl -fsSL https://pkgs.dopame.ai/acde/install.sh | sh
```

This installs into `~/.acde` (change it with `ACDE_INSTALL`) and adds `~/.acde/bin` to PATH in the startup files of every shell on the machine, once each, and lists them: `~/.profile` (sh, dash, ksh and login shells), `~/.bashrc` and an existing `~/.bash_profile` or `~/.bash_login` (bash), `~/.zshrc` and `~/.zprofile` (zsh), `~/.config/fish/conf.d/acde.fish` (fish), `~/.cshrc` and an existing `~/.tcshrc` (csh, tcsh), and nushell's `env.nu`. To leave your startup files alone:

```sh
curl -fsSL https://pkgs.dopame.ai/acde/install.sh | sh -s -- --no-modify-path
```

To install a specific version: `sh -s -- --version 0.1.0`.

## Windows

In PowerShell:

```powershell
irm https://pkgs.dopame.ai/acde/install.ps1 | iex
```

This installs into `%USERPROFILE%\.acde` and adds it to your user `Path`.

`irm | iex` cannot pass parameters. Set environment variables before it, or run the script as a script block to pass its parameters `-Version` and `-NoModifyPath`:

```powershell
$env:ACDE_VERSION = '0.1.0'; $env:ACDE_NO_MODIFY_PATH = '1'
irm https://pkgs.dopame.ai/acde/install.ps1 | iex

& ([scriptblock]::Create((irm https://pkgs.dopame.ai/acde/install.ps1))) -Version 0.1.0 -NoModifyPath
```

### Installer options

| Option | `install.sh` | `install.ps1` |
| --- | --- | --- |
| Install a specific version (and its runtime) | `--version X.Y.Z` | `-Version X.Y.Z` or `ACDE_VERSION` |
| Leave startup files / the user `Path` alone | `--no-modify-path` | `-NoModifyPath` or `ACDE_NO_MODIFY_PATH` set to any value |
| Install somewhere else than `~/.acde` | `ACDE_INSTALL` | `ACDE_INSTALL` |

Environment variables set this way stay set in that terminal; remove them afterwards (`Remove-Item Env:ACDE_VERSION`) if a later install should take the defaults.

## Verify

> **Open a new terminal first.** The installer changes `PATH` only for terminals opened after it, so in the terminal you installed from, `acde` is `command not found`. To use that terminal anyway, run the last line the installer printed (`export PATH=…`, or `$env:Path = …` in PowerShell).

In the new terminal, run:

```sh
acde --version
```

It prints the acde version, the SDK version and contract level it was built with, and the runtime it found with its version and contract level.

## The runtime

`acde dev` and `acde test` run your app in the runtime, acdert. The installer puts the acdert release that this acde pairs with next to it: the binary as `bin/acdert` (`acdert.exe` on Windows) and its host files as `bin/app/`, both checked against the release's `SHA256SUMS`. The pairing is recorded with each acde release, so `--version` installs the matching runtime too. If the runtime cannot be installed (no build for your platform, a failed download or checksum), the installer installs nothing and keeps what you had. Inside the Dopame virtual machine, `acdert` is already on PATH.

acde looks for the runtime in this order:

1. `ACDERT`: the path of an acdert binary, or the name of one on PATH;
2. the acdert the installer put next to acde;
3. `acdert` on PATH.

When none is there, `acde dev` stops and says so.

The runtime renders pages only on the GPU, so it needs a working GPU (Metal on macOS, DirectX 12 on Windows, Vulkan on Linux).

### Install the runtime by hand

Use this only when the installer cannot set up the runtime, for example without access to `https://pkgs.dopame.ai/` from the machine, and set `ACDERT` to the result. Each runtime release is in `https://pkgs.dopame.ai/acdert/<version>/`, and `https://pkgs.dopame.ai/acdert/latest.json` names the latest version. A release has:

| File | What it is |
| --- | --- |
| `acdert-aarch64-apple-darwin` | The runtime for macOS on Apple silicon |
| `acdert-x86_64-apple-darwin` | The runtime for macOS on Intel |
| `acdert-x86_64-unknown-linux-gnu` | The runtime for Linux x86_64 |
| `acdert-x86_64-pc-windows-msvc.exe` | The runtime for Windows x64 |
| `acdert-host-<version>.tar.gz` | The runtime's own scripts (an `app/` directory), the same on every platform |
| `SHA256SUMS` | Checksums of the files above |

Download the binary for your platform, the host archive, and `SHA256SUMS`, and check them. Extract the host archive into the binary's directory: acdert looks for `app/` next to itself and does not start without it. Rename the binary to `acdert` (`acdert.exe` on Windows).

On macOS or Linux, paste the lines below, with `target` set for your platform (the parentheses keep your terminal in its current directory): `aarch64-apple-darwin` on Apple silicon, `x86_64-apple-darwin` on an Intel Mac, `x86_64-unknown-linux-gnu` on Linux.

```sh
(
target=aarch64-apple-darwin
base=https://pkgs.dopame.ai/acdert
version=$(curl -fsSL "$base/latest.json" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
mkdir -p ~/.acdert && cd ~/.acdert
curl -fsSLO "$base/$version/acdert-$target" -O "$base/$version/acdert-host-$version.tar.gz" -O "$base/$version/SHA256SUMS"
grep -E " (acdert-$target|acdert-host-$version\.tar\.gz)\$" SHA256SUMS | sha256sum -c - &&
  rm -rf app && tar -xzf "acdert-host-$version.tar.gz" &&
  mv "acdert-$target" acdert && chmod +x acdert
)
```

`sha256sum` prints `OK` for both files; if it doesn't, nothing is extracted. Then point acde at it: add this line to your shell's startup file, and run it in the current terminal too:

```sh
export ACDERT="$HOME/.acdert/acdert"
```

Adding `~/.acdert` to `PATH` works as well.

On Windows, in PowerShell:

```powershell
& {
  $ProgressPreference = 'SilentlyContinue'
  $base = 'https://pkgs.dopame.ai/acdert'
  $version = (Invoke-RestMethod "$base/latest.json").version
  $dir = "$env:USERPROFILE\.acdert"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $files = 'acdert-x86_64-pc-windows-msvc.exe', "acdert-host-$version.tar.gz"
  foreach ($f in $files + 'SHA256SUMS') { Invoke-WebRequest "$base/$version/$f" -OutFile "$dir\$f" }
  $sums = Get-Content "$dir\SHA256SUMS"
  foreach ($f in $files) {
    $want = (($sums | Where-Object { $_ -like "* $f" }) -split ' ')[0]
    if ((Get-FileHash "$dir\$f").Hash -ne $want) { throw "checksum mismatch: $f" }
  }
  Remove-Item -Recurse -Force "$dir\app" -ErrorAction SilentlyContinue
  tar -xzf "$dir\acdert-host-$version.tar.gz" -C $dir
  Move-Item -Force "$dir\acdert-x86_64-pc-windows-msvc.exe" "$dir\acdert.exe"
  [Environment]::SetEnvironmentVariable('ACDERT', "$dir\acdert.exe", 'User')
  $env:ACDERT = "$dir\acdert.exe"
}
```

This sets `ACDERT` for your user and for the current terminal. App backends don't run on Windows yet; see [Platform support](../reference/platforms.md).

To upgrade the runtime, run the same commands again. Check that it works with a new project:

```sh
acde new hello --template html --install --yes
cd hello
acde dev
```

### Install the Dopame desktop

On its own, `acde dev` runs only your app. To run it inside Dopame's desktop (`acde dev --desktop dopame`, `acde test --desktop dopame`), install the `dopame` desktop package too. `https://pkgs.dopame.ai/acde-dopame/latest.json` gives the latest build: its `base` is the directory with `dopame.tar.gz` and `SHA256SUMS`. The archive holds one package directory, `dopame/`; extract it into the package directory `$XDG_DATA_HOME/acde/packages` (by default `~/.local/share/acde/packages`):

```sh
(
base=$(curl -fsSL https://pkgs.dopame.ai/acde-dopame/latest.json | sed -n 's/.*"base": *"\([^"]*\)".*/\1/p')
packages="${XDG_DATA_HOME:-$HOME/.local/share}/acde/packages"
mkdir -p "$packages" && cd "$(mktemp -d)"
curl -fsSLO "${base}dopame.tar.gz" -O "${base}SHA256SUMS"
sha256sum -c SHA256SUMS &&
  rm -rf "$packages/dopame" && tar -xzf dopame.tar.gz -C "$packages"
)
```

On Windows the package directory is `%USERPROFILE%\.local\share\acde\packages`; extract the same archive there with `tar -xzf dopame.tar.gz -C <that directory>`.

Then, in your project:

```sh
acde dev --desktop dopame
```

Your app is in the desktop's app list; open it from there. The desktop's assistant needs a program that is not part of this download, so the output has a warning about it (`no assistant`); everything else works. For where the runtime looks for packages, see [Local install](../guide/install.md#package-lookup).

## Upgrade and uninstall

To upgrade, run the install command again; it upgrades the runtime too. Each version is installed in `~/.acde/versions/<version>`, with its runtime in its `bin`, and `~/.acde/current` points to the one in use.

To uninstall, run `acde skills remove` if you installed the skill, delete `~/.acde`, and remove the `# acde` lines the installer added to your shells' startup files (it listed them). If you installed the runtime by hand or the desktop as above, also delete `~/.acdert` and `~/.local/share/acde/packages/dopame`, and remove the `ACDERT` line.
