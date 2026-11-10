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

The installer downloads one archive, checks its SHA-256, unpacks it into `~/.acde` (`%USERPROFILE%\.acde` on Windows), and adds its `bin` directory to PATH in the user's shell startup file. It needs no root. Running it again upgrades an existing install.

The PATH change reaches new shells only. In the shell you are in, call acde by its path, `~/.acde/bin/acde` (Windows: `%USERPROFILE%\.acde\current\bin\acde.cmd`), or put that directory on PATH first.

## 3. Check that it runs

```sh
acde
```

It prints its usage, a line beginning `acde: usage: acde <command>` and one line per command, and exits with code 1; that is what success looks like here. If it says Bun or Node.js is missing or too old, go back to step 1.

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

## 5. Look for the runtime

`acde new`, `acde check` and `acde build` work now. `acde dev` and `acde test` also need the Dopame runtime, acdert, which is not part of acde. Check for it:

```sh
echo "${ACDERT:-}"
command -v acdert
```

(Windows: `echo $env:ACDERT` and `where.exe acdert`.) acdert comes with the Dopame virtual machine, where it is already on PATH. If it is not on this machine, do not try to download or build it: say so in the report.

## 6. Try it

In a temporary directory:

```sh
acde new hello --template html --install --yes
cd hello
acde check
acde build
```

`acde check` prints a line beginning `ok: hello, app`, and `acde build` one beginning `acde: built app hello into`. If the runtime is there, also run the app without a window and take a picture of it:

```sh
acde dev --headless
```

`acde dev` keeps running: start it in the background, wait for its output to show the app's first build, then from the same directory run `acde webs` and `acde shot hello -o hello.png`, look at the PNG, and stop `acde dev`. Remove the temporary directory when you are done.

## 7. Report

Tell the user, in a few lines:

- the acde version installed and where (`~/.acde/versions/<version>`), and whether a new terminal is needed for PATH;
- which JavaScript runtime acde will use;
- where the skill was installed (the output of `acde skills`);
- whether the runtime was found, and that `acde dev` and `acde test` need it if it was not;
- which commands of step 6 you ran and what they printed, and anything that failed.

Report only what you ran and saw. Then suggest a first step: `acde new my-app`.
