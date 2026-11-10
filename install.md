# Set up acde

You are a coding agent, and the user asked you to set up acde on this machine. acde is the command line tool for building apps and desktops for Dopame OS. Do the steps below in order and run the commands yourself. Ask the user only where a step says to. End with the report in the last step.

Everything you need comes from `https://pkgs.dopame.ai/acde/`. Do not fetch installers for acde from anywhere else.

## 1. A JavaScript runtime

acde runs on Bun 1.4 or newer, or Node.js 22.3 or newer. Check what is there:

```sh
bun --version
node --version
```

If neither is new enough, ask the user whether to install Bun (https://bun.sh) or Node.js (https://nodejs.org), install the one they choose the way its site says, and check again.

## 2. Install acde

macOS and Linux:

```sh
curl -fsSL https://pkgs.dopame.ai/acde/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://pkgs.dopame.ai/acde/install.ps1 | iex
```

Run the plain command unless the user asked for something else. The installers take options: a version (`sh -s -- --version X.Y.Z`; in PowerShell `ACDE_VERSION`), leaving the shell startup files or the user `Path` alone (`sh -s -- --no-modify-path`; in PowerShell `ACDE_NO_MODIFY_PATH=1`), and another install directory (`ACDE_INSTALL`, both). `irm | iex` cannot pass parameters, so in PowerShell set the environment variables first, or run `& ([scriptblock]::Create((irm https://pkgs.dopame.ai/acde/install.ps1))) -Version X.Y.Z -NoModifyPath`.

The installer downloads the acde archive and the Dopame runtime it pairs with, acdert (the binary for this platform and its host files), checks every SHA-256, and unpacks them into `~/.acde` (`%USERPROFILE%\.acde` on Windows): `acdert` ends up in the same `bin` directory as `acde`. It then adds that directory to PATH in the user's shell startup file. It needs no root. If any download or check fails, it installs nothing and an earlier install stays as it was. Running it again upgrades an existing install, runtime included.

The PATH change reaches new shells only. When the shell you are in does not have it yet, the installer's last line is the command that puts it on PATH there; run it, or call acde by its path, `~/.acde/bin/acde` (Windows: `%USERPROFILE%\.acde\current\bin\acde.exe`).

## 3. Check that it runs

```sh
acde --help
```

It prints its usage, a line beginning `usage: acde <command>` and one line per command, and exits with code 0. If it says Bun or Node.js is missing or too old, go back to step 1.

## 4. Install the acde skill

acde carries a skill in the Agent Skills format: how to create, run, inspect and test acde projects, with a reference for every command, config field and module. Install it:

```sh
acde skills install
acde skills
```

The first command links the skill into `~/.agents/skills` and into the skills directory of every agent it finds on this machine. The second lists where it now is. Look for your own skills directory in that list:

- If it is there, you are done with this step.
- If you read skills from a directory that is not listed, run `acde skills install --dir <that directory>`.
- If you have no skills mechanism, run `acde skills path`; it prints a directory whose `SKILL.md` is the entry point. Offer to add a line to the user's instruction file for you that says to read that file before working on an acde project.

Most agents load new skills when a session starts. For the rest of this session, read `SKILL.md` in the directory `acde skills path` prints before you do anything else with acde.

## 5. Check the runtime

`acde dev` and `acde test` run apps in the Dopame runtime, acdert. The installer put the acdert that this acde pairs with next to it, so they work now. acde looks for acdert in this order: `ACDERT`, the acdert installed next to acde, then `acdert` on PATH (in the Dopame virtual machine it is already on PATH). Check which one it finds:

```sh
acde --version
```

It prints the acde version, the SDK version and contract level, and the acdert it found with its version and contract level. If it says no acdert was found, the install did not finish: run the installer again and report what it printed. Only if the installer cannot work here (no access to `https://pkgs.dopame.ai/`, or no acdert build for this platform), ask the user whether to set the runtime up by hand; if they agree, follow the section "Install the runtime by hand" in the skill's `references/start/install.md` (in the directory `acde skills path` prints), and nothing else: do not build it or fetch it from anywhere else.

## 6. Try it

In a temporary directory:

```sh
acde new hello --template html --install --yes
cd hello
acde check
acde build
```

`acde check` prints a line beginning `ok: hello, app`, and `acde build` one beginning `acde: built app hello into`. Then run the app without a window and take a picture of it:

```sh
acde dev --headless
```

`acde dev` keeps running: start it in the background. It first prints a line beginning `acde: dev app hello (headless):` (the build is done and acdert is starting). The session is ready when `acde webs`, run from the same directory, lists a page whose APP is `hello`; until then `acde webs` says `no acde dev is running`, so run it again every second or two, for up to a minute. Then run `acde shot hello -o hello.png`, look at the PNG, and end the session with `acde stop`. Remove the temporary directory when you are done.

## 7. Report

Tell the user, in a few lines:

- the acde version installed and where (`~/.acde/versions/<version>`), and whether a new terminal is needed for PATH;
- which JavaScript runtime acde will use;
- where the skill was installed (the output of `acde skills`);
- the acdert that `acde --version` found, with its version and contract level;
- which commands of step 6 you ran and what they printed, and anything that failed.

Report only what you ran and saw. Then suggest a first step: `acde new my-app`.
